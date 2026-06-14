import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { hashDocument } from './documentHasher.js';
import { buildMerkleTree, getMerkleRoot } from './merkleBatcher.js';
import { anchorToAlgorand } from './algorandAnchor.js';
import { assembleBundle, saveBundleToFile } from './proofBundleAssembler.js';
import { StateProofData } from './stateProofCollector.js';
import { downloadEnvelopePdf, getSignerMetadata } from './docusignClient.js';

const SIGNATURE_HEADER = 'x-docusign-signature-1';
const STATE_PROOF_INTERVAL = 256;
const BUNDLES_DIR = 'bundles';

interface DocuSignWebhookBody {
  status?: string;
  envelopeId?: string;
  data?: { envelopeId?: string };
  // Offline test hook: when DOCUSIGN_ALLOW_TEST_PDF=true, an inline base64 PDF
  // bypasses the DocuSign download so the pipeline can run without credentials.
  testPdfBase64?: string;
}

function validateSignature(rawBody: Buffer, headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const key = process.env.DOCUSIGN_HMAC_KEY;
  if (!key) return false;

  const expected = createHmac('sha256', key).update(rawBody).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(headerValue);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function extractEnvelopeId(body: DocuSignWebhookBody): string | undefined {
  const raw = body.envelopeId ?? body.data?.envelopeId;
  if (!raw) return undefined;
  // Fix 6: strip path-traversal characters before using in filesystem paths.
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  return sanitized || undefined;
}

// Fire-and-forget: the webhook responds 200 before this completes so DocuSign
// does not retry on slow on-chain confirmation.
async function processEnvelope(envelopeId: string, testPdfBase64?: string): Promise<void> {
  let pdfBuffer: Buffer;
  let docusignSigners: Awaited<ReturnType<typeof getSignerMetadata>> = [];

  if (testPdfBase64 && process.env.DOCUSIGN_ALLOW_TEST_PDF === 'true') {
    pdfBuffer = Buffer.from(testPdfBase64, 'base64');
  } else {
    [pdfBuffer, docusignSigners] = await Promise.all([
      downloadEnvelopePdf(envelopeId),
      getSignerMetadata(envelopeId),
    ]);
  }

  const documentHash = hashDocument(pdfBuffer);
  const tree = buildMerkleTree([documentHash]);
  const merkleRoot = getMerkleRoot(tree);

  const { txId, confirmedRound, blockTime } = await anchorToAlgorand(merkleRoot, [envelopeId]);

  // State proof is not yet generated at anchor time; record the covering round.
  const stateProof: StateProofData = {
    stateProofRound: Math.ceil(confirmedRound / STATE_PROOF_INTERVAL) * STATE_PROOF_INTERVAL,
    raw: null,
  };

  const bundle = assembleBundle({
    envelopeId,
    pdfBuffer,
    txId,
    confirmedRound,
    merkleTree: tree,
    stateProof,
    anchorTime: blockTime,
    signers: [],
    docusignSigners,
  });

  await saveBundleToFile(bundle, join(BUNDLES_DIR, `${envelopeId}.json`));
}

export const webhookRouter = Router();

webhookRouter.post('/docusign', (req: Request, res: Response): void => {
  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody) || !validateSignature(rawBody, req.header(SIGNATURE_HEADER) ?? undefined)) {
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

  if (body.status !== 'completed') {
    res.status(200).json({ received: true, ignored: body.status ?? 'unknown' });
    return;
  }

  const envelopeId = extractEnvelopeId(body);
  if (!envelopeId) {
    res.status(400).json({ error: 'missing envelopeId' });
    return;
  }

  res.status(200).json({ received: true, envelopeId });

  processEnvelope(envelopeId, body.testPdfBase64).catch(e => {
    process.stderr.write(`[webhook] failed to process envelope ${envelopeId}: ${(e as Error).message}\n`);
  });
});
