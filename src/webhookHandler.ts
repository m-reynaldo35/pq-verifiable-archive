import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { hashDocument } from './documentHasher.js';
import { createProofBundle } from './proofBundleAssembler.js';
import { downloadEnvelopePdf, getSignerMetadata } from './docusignClient.js';
import { findRecordByEnvelopeId, saveRecord, ArchiveRecord } from './archiveStore.js';
import { isProduction } from './config.js';
import type { Signer } from './bundleSigner.js';

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

// Envelopes currently being processed — together with the archive lookup this
// makes the webhook idempotent, so DocuSign retries and replayed requests do
// not anchor the same envelope twice.
const inFlight = new Set<string>();

async function processEnvelope(envelopeId: string, testPdfBase64?: string): Promise<void> {
  let pdfBuffer: Buffer;
  let signers: Signer[] = [];

  if (testPdfBase64 && testPdfAllowed()) {
    pdfBuffer = Buffer.from(testPdfBase64, 'base64');
  } else {
    [pdfBuffer, signers] = await Promise.all([
      downloadEnvelopePdf(envelopeId),
      getSignerMetadata(envelopeId),
    ]);
  }

  const documentHash = hashDocument(pdfBuffer);
  const bundle = await createProofBundle({
    documentHash,
    envelopeId,
    signers,
    signerSource: 'docusign-connect',
  });

  const record: ArchiveRecord = {
    id: `ds-${envelopeId}`,
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
  };
  await saveRecord(record, JSON.stringify(bundle, null, 2), pdfBuffer);
}

export const webhookRouter = Router();

webhookRouter.post('/docusign', (req: Request, res: Response): void => {
  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody) || !validateSignature(req, rawBody)) {
    res.status(400).json({ error: 'invalid or missing signature' });
    return;
  }

  let body: DocuSignWebhookBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as DocuSignWebhookBody;
  } catch {
    res.status(400).json({ error: 'invalid JSON body' });
    return;
  }

  if (!isCompleted(body)) {
    res.status(200).json({ received: true, ignored: body.event ?? body.status ?? 'unknown' });
    return;
  }

  const envelopeId = extractEnvelopeId(body);
  if (!envelopeId) {
    res.status(400).json({ error: 'missing envelopeId' });
    return;
  }

  if (inFlight.has(envelopeId) || findRecordByEnvelopeId(envelopeId)) {
    res.status(200).json({ received: true, envelopeId, duplicate: true });
    return;
  }

  // Respond before anchoring so DocuSign does not retry on slow confirmation.
  res.status(200).json({ received: true, envelopeId });

  inFlight.add(envelopeId);
  processEnvelope(envelopeId, body.testPdfBase64)
    .catch(e => {
      process.stderr.write(`[webhook] failed to process envelope ${envelopeId}: ${(e as Error).message}\n`);
    })
    .finally(() => inFlight.delete(envelopeId));
});
