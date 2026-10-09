import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { hashDocument } from './documentHasher.js';
import { createProofBundle } from './proofBundleAssembler.js';
import { downloadEnvelopePdf, getSignerMetadata, getEnvelopeCompletion } from './docusignClient.js';
import {
  saveRecord,
  newRecordId,
  webhookCanonicalId,
  newShareToken,
  indexShareToken,
  ArchiveRecord,
} from './archiveStore.js';
import { tryClaim, setClaim, releaseClaim } from './claims.js';
import { isProduction } from './config.js';
import type { DocumentCapture, Signer } from './bundleSigner.js';

// DocuSign sends one header per active HMAC key (X-DocuSign-Signature-1, -2, …)
// so keys can be rotated; a request is authentic if any of them matches.
const MAX_SIGNATURE_HEADERS = 10;

interface DocuSignWebhookBody {
  // Connect 2.0 JSON (SIM): { event: 'envelope-completed', data: { envelopeId, envelopeSummary: { status } } }
  event?: string;
  data?: { envelopeId?: string; envelopeSummary?: { status?: string } };
  // Legacy/aggregate shape.
  status?: string;
  envelopeId?: string;
  // Offline test hook, honoured only when DOCUSIGN_ALLOW_TEST_PDF=true outside production.
  testPdfBase64?: string;
}

function signatureMatches(expected: Buffer, provided: string): boolean {
  const providedBuf = Buffer.from(provided);
  return expected.length === providedBuf.length && timingSafeEqual(expected, providedBuf);
}

function validateSignature(req: Request, rawBody: Buffer): boolean {
  const key = process.env.DOCUSIGN_HMAC_KEY;
  if (!key) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(rawBody).digest('base64'));
  let ok = false;
  for (let i = 1; i <= MAX_SIGNATURE_HEADERS; i++) {
    const header = req.header(`x-docusign-signature-${i}`);
    if (header === undefined) break;
    // Check every header (no early exit) to keep timing independent of position.
    if (signatureMatches(expected, header)) ok = true;
  }
  return ok;
}

function isCompleted(body: DocuSignWebhookBody): boolean {
  return (
    body.event === 'envelope-completed' ||
    body.data?.envelopeSummary?.status === 'completed' ||
    body.status === 'completed'
  );
}

function extractEnvelopeId(body: DocuSignWebhookBody): string | undefined {
  const raw = body.data?.envelopeId ?? body.envelopeId;
  if (typeof raw !== 'string') return undefined;
  // Strip anything that is not safe in an id or file name.
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  return sanitized || undefined;
}

function testPdfAllowed(): boolean {
  return process.env.DOCUSIGN_ALLOW_TEST_PDF === 'true' && !isProduction();
}

// One durable claim per envelope (keyed by its canonical id) makes the webhook
// idempotent across instances. States: processing -> done. Processing happens
// BEFORE the response, so a failure returns 5xx and DocuSign Connect retries;
// the claim is released on failure, and a claim stuck in "processing" (the
// function was killed mid-way) is taken over after STALE_MS.
const claimKey = (canonicalId: string) => `webhooks/${canonicalId}`;
const STALE_MS = 3 * 60 * 1000;

async function processEnvelope(envelopeId: string, canonicalId: string, testPdfBase64?: string): Promise<void> {
  let pdfBuffer: Buffer;
  let signers: Signer[] = [];
  let capture: DocumentCapture | undefined;

  if (testPdfBase64 && testPdfAllowed()) {
    pdfBuffer = Buffer.from(testPdfBase64, 'base64');
  } else {
    // Trust DocuSign's envelope status, not the webhook body's, before
    // anchoring anything.
    const completion = await getEnvelopeCompletion(envelopeId);
    if (completion.status !== 'completed' || !completion.completedAt) {
      throw new Error(`envelope status is ${completion.status}, not completed`);
    }
    [pdfBuffer, signers] = await Promise.all([
      downloadEnvelopePdf(envelopeId),
      getSignerMetadata(envelopeId),
    ]);
    capture = {
      source: 'docusign-envelope-combined',
      envelopeCompletedAt: new Date(completion.completedAt).toISOString(),
      capturedAt: new Date().toISOString(),
    };
  }

  const documentHash = hashDocument(pdfBuffer);
  const bundle = await createProofBundle({
    documentHash,
    envelopeId,
    signers,
    signerSource: 'docusign-connect',
    ...(capture ? { capture } : {}),
  });

  const record: ArchiveRecord = {
    id: newRecordId(`ds-${canonicalId}`),
    envelopeId,
    title: `docusign-${envelopeId}`,
    filename: `${envelopeId}.pdf`,
    documentHash,
    signers,
    signerSource: 'docusign-connect',
    txId: bundle.algorandTxnId,
    round: bundle.algorandRound,
    blockTimestamp: bundle.blockTimestamp,
    stateProofRound: bundle.stateProofRound,
    archivedAt: new Date().toISOString(),
    ...(capture ? { capture } : {}),
    shareToken: newShareToken(),
  };
  await saveRecord(record, JSON.stringify(bundle, null, 2), pdfBuffer);
  // The document is archived and anchored at this point; a failed link index
  // must not make DocuSign retry (and anchor twice). The operator can reissue it.
  await indexShareToken(record.id, record.shareToken as string).catch(e =>
    process.stderr.write(`[webhook] could not index signer link for ${record.id}: ${(e as Error).message}\n`),
  );
}

export const webhookRouter = Router();

webhookRouter.post('/docusign', async (req: Request, res: Response): Promise<void> => {
  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody) || !validateSignature(req, rawBody)) {
    res.status(401).json({ error: 'invalid or missing signature' });
    return;
  }

  let body: DocuSignWebhookBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as DocuSignWebhookBody;
  } catch {
    res.status(400).json({ error: 'invalid JSON body' });
    return;
  }

  const event = String(body.event ?? body.status ?? 'unknown').replace(/[^\w.-]/g, '').slice(0, 64);
  // One line per delivery, no signer data: enough to debug Connect setup.
  const log = (outcome: string) =>
    process.stdout.write(`[webhook] event=${event} envelope=${extractEnvelopeId(body) ?? '-'} outcome=${outcome}\n`);

  if (!isCompleted(body)) {
    log('ignored');
    res.status(200).json({ received: true, ignored: event });
    return;
  }

  const envelopeId = extractEnvelopeId(body);
  if (!envelopeId) {
    res.status(400).json({ error: 'missing envelopeId' });
    return;
  }
  const canonicalId = webhookCanonicalId(envelopeId);
  const key = claimKey(canonicalId);

  try {
    const claim = await tryClaim(key, 'processing');
    if (!claim.fresh) {
      const current = claim.current;
      if (current?.state === 'done') {
        log('duplicate');
        res.status(200).json({ received: true, envelopeId, duplicate: true });
        return;
      }
      if (current && Date.now() - current.at < STALE_MS) {
        // Another delivery is processing it right now; ask DocuSign to retry.
        log('in-progress');
        res.status(503).json({ error: 'envelope is being processed' });
        return;
      }
      await setClaim(key, 'processing'); // take over a stale claim
    }
  } catch (e) {
    process.stderr.write(`[webhook] claim store unavailable: ${(e as Error).message}\n`);
    res.status(503).json({ error: 'temporarily unavailable' });
    return;
  }

  try {
    await processEnvelope(envelopeId, canonicalId, body.testPdfBase64);
    await setClaim(key, 'done');
    log('anchored');
    res.status(200).json({ received: true, envelopeId });
  } catch (e) {
    process.stderr.write(`[webhook] failed to process envelope ${envelopeId}: ${(e as Error).message}\n`);
    log('failed');
    await releaseClaim(key).catch(() => undefined);
    // A 5xx makes DocuSign Connect retry the delivery.
    res.status(500).json({ error: 'processing failed — will be retried' });
  }
});
