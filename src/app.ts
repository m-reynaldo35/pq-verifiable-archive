import 'dotenv/config';
// Polyfill globalThis.crypto for Node.js environments where it isn't auto-set.
// Required by @noble/hashes (used by @noble/post-quantum for ML-DSA signing).
import { webcrypto, createHash, timingSafeEqual } from 'node:crypto';
if (!globalThis.crypto) (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;
import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { webhookRouter } from './webhookHandler.js';
import { assertSigningKeysConsistent } from './bundleSigner.js';
import type { Signer } from './bundleSigner.js';
import { verifyBundle, VerifyOptions } from './verifyBundle.js';
import { hashDocument } from './documentHasher.js';
import { createProofBundle } from './proofBundleAssembler.js';
import { requireAnchorPayment, markPaymentFulfilled, x402DiscoveryDocument } from './anchorPaywall.js';
import { issuerStatus } from './issuerCheck.js';
import { validateSigners, validateEnvelopeId } from './signers.js';
import { isProduction, trustAnchorFromEnv } from './config.js';
import {
  listRecords,
  getRecord,
  saveRecord,
  newRecordId,
  readBundle,
  readPdf,
  storageKind,
  rotateShareToken,
  resolveShareToken,
  sharedView,
  ArchiveRecord,
} from './archiveStore.js';

const EXPLORER_TX_BASE = 'https://explorer.perawallet.app/tx/';

function slugify(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'document'
  );
}

// ---------------------------------------------------------------------------
// Startup checks. In production an insecure configuration makes every request
// fail with 503 (the serverless equivalent of refusing to start) instead of
// silently running open.
// ---------------------------------------------------------------------------
const startupProblems: string[] = [];
if (!process.env.PORTAL_API_KEY) startupProblems.push('PORTAL_API_KEY is not set (archive and document endpoints would be public)');
if (!process.env.X402_TREASURY_ADDRESS) startupProblems.push('X402_TREASURY_ADDRESS is not set (/api/anchor would be free and unmetered)');
try {
  assertSigningKeysConsistent();
} catch (e) {
  startupProblems.push(`signing key check failed: ${(e as Error).message}`);
}
if (process.env.VERCEL && storageKind() !== 'vercel-blob') {
  startupProblems.push('no Vercel Blob store connected (BLOB_READ_WRITE_TOKEN unset) — archive and replay guard need durable storage');
}
for (const p of startupProblems) process.stderr.write(`${isProduction() ? 'fatal' : 'warn'}: ${p}\n`);
const misconfigured = isProduction() && startupProblems.length > 0;

const verifyOptions: VerifyOptions = {
  trust: trustAnchorFromEnv(),
  indexerUrl: process.env.ALGORAND_INDEXER_URL || undefined,
};

export const app = express();
app.disable('x-powered-by');

if (misconfigured) {
  app.use((_req, res) => {
    res.status(503).json({ error: 'service misconfigured — see server logs' });
  });
}

// Behind Vercel's (or any) reverse proxy, req.ip is the proxy's address unless
// Express is told how many hops to trust. Without this every client shares one
// rate-limit bucket.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? (process.env.VERCEL ? 1 : 0)));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://mainnet-idx.algonode.cloud; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});

// API key auth for operator-only endpoints (archive upload, document listing
// and downloads). Without PORTAL_API_KEY these are only reachable outside
// production (see startup checks above).
function apiKeyDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = process.env.PORTAL_API_KEY;
  if (!key) {
    // Fail closed: an unset key never means "open" unless explicitly allowed
    // for local development.
    if (process.env.PQVA_ALLOW_OPEN_PORTAL === 'true') {
      next();
      return;
    }
    res.status(503).json({ error: 'operator API key not configured' });
    return;
  }
  const auth = req.headers['authorization'];
  const provided =
    req.header('x-api-key') ?? (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined);
  if (!provided || !timingSafeEqual(apiKeyDigest(provided), apiKeyDigest(key))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function limiter(max: number, message: string) {
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

const verifyLimiter = limiter(20, 'too many verify requests — try again in a minute');
const archiveLimiter = limiter(10, 'too many archive requests — try again in a minute');
const anchorLimiter = limiter(10, 'too many anchor requests — try again in a minute');

// Vercel rejects function request bodies over 4.5 MB before they reach the
// app, so the server-side upload limit sits just under that. Larger documents
// can still be checked with the in-browser verifier, which never uploads them.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

app.use('/webhook/docusign', express.raw({ type: 'application/json', limit: '1mb' }));
app.use('/webhook', webhookRouter);

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', storage: storageKind(), timestamp: new Date().toISOString() });
});

app.get('/.well-known/x402', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(x402DiscoveryDocument());
});

app.get('/demo/bundle', (_req, res) => res.sendFile(path.resolve('bundles/sample-contract-bundle.json')));
app.get('/demo/pdf', (_req, res) => res.sendFile(path.resolve('assets/sample-contract.pdf')));

app.post(
  '/api/verify',
  verifyLimiter,
  upload.fields([
    { name: 'bundle', maxCount: 1 },
    { name: 'pdf', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const bundleFile = files?.bundle?.[0];
    if (!bundleFile) {
      res.status(400).json({ valid: false, steps: [], signers: [], error: 'bundle file is required' });
      return;
    }

    let bundle: unknown;
    try {
      bundle = JSON.parse(bundleFile.buffer.toString('utf8'));
    } catch {
      res.status(400).json({ valid: false, steps: [], signers: [], error: 'bundle is not valid JSON' });
      return;
    }

    try {
      res.json(await verifyBundle(bundle, files?.pdf?.[0]?.buffer, verifyOptions));
    } catch (e) {
      console.error(`verify failed: ${(e as Error).message}`);
      res.status(500).json({ valid: false, steps: [], signers: [], error: 'verification failed due to an internal error' });
    }
  },
);

// Refuse to anchor (or take payment) unless the issuer wallet, the key
// registration and the signing key agree. Checked once per instance.
async function requireIssuerReady(_req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const status = await issuerStatus();
  if (status.ok) {
    next();
    return;
  }
  res.status(503).json({ error: status.retryable ? 'issuer check unavailable — retry shortly' : 'issuer misconfigured' });
}

app.post('/api/archive', archiveLimiter, requireApiKey, requireIssuerReady, upload.single('pdf'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'pdf file is required' });
    return;
  }

  let rawSigners: unknown;
  try {
    rawSigners = JSON.parse((req.body as { signers?: string }).signers ?? '[]');
  } catch {
    res.status(400).json({ error: 'signers field is not valid JSON' });
    return;
  }
  const checked = validateSigners(rawSigners);
  if ('error' in checked) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const signers = checked.signers;

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');

  const write = (obj: unknown): void => {
    res.write(JSON.stringify(obj) + '\n');
  };

  try {
    const pdfBuffer = file.buffer;
    const documentHash = hashDocument(pdfBuffer);
    const slug = slugify(file.originalname);
    const id = newRecordId(slug);

    write({ step: 'hash', status: 'done', detail: `sha256: ${documentHash}` });
    write({ step: 'anchor', status: 'running', detail: 'Anchoring to Algorand mainnet…' });

    const bundle = await createProofBundle({
      documentHash,
      envelopeId: id,
      signers,
      signerSource: 'requester-asserted',
    });
    write({
      step: 'anchor',
      status: 'done',
      detail: `txn ${bundle.algorandTxnId} · round ${bundle.algorandRound} · ${EXPLORER_TX_BASE + bundle.algorandTxnId}`,
    });
    write({ step: 'sign', status: 'done', detail: 'ML-DSA-65 (NIST FIPS-204)' });

    const record: ArchiveRecord = {
      id,
      envelopeId: id,
      title: slug,
      filename: file.originalname,
      documentHash,
      signers,
      signerSource: 'requester-asserted',
      txId: bundle.algorandTxnId,
      round: bundle.algorandRound,
      blockTimestamp: bundle.blockTimestamp,
      stateProofRound: bundle.stateProofRound,
      archivedAt: new Date().toISOString(),
    };
    await saveRecord(record, JSON.stringify(bundle, null, 2), pdfBuffer);
    write({ step: 'save', status: 'done', detail: 'Saved to archive' });
    write({ step: 'stateproof', status: 'info', detail: 'state proof for this round usually appears in ~20 min (informational)' });
    write({ done: true, record });
    res.end();
  } catch (e) {
    console.error(`archive failed: ${(e as Error).message}`);
    write({ step: 'error', status: 'error', detail: 'archiving failed due to an internal error' });
    res.end();
  }
});

app.get('/api/documents', verifyLimiter, requireApiKey, async (_req, res) => {
  try {
    res.json(await listRecords());
  } catch (e) {
    console.error(`list documents failed: ${(e as Error).message}`);
    res.status(500).json({ error: 'could not list documents' });
  }
});

async function sendArchived(
  res: express.Response,
  load: () => Promise<ArchiveRecord | undefined>,
  read: (id: string) => Promise<Buffer | null>,
  filename: (r: ArchiveRecord) => string,
  contentType: string,
): Promise<void> {
  try {
    const record = await load();
    const data = record ? await read(record.id) : null;
    if (!record || !data) {
      res.status(404).json({ error: 'document not found' });
      return;
    }
    res.attachment(filename(record)).type(contentType).send(data);
  } catch (e) {
    console.error(`download failed: ${(e as Error).message}`);
    res.status(500).json({ error: 'could not load archived file' });
  }
}

app.get('/api/documents/:id/bundle', requireApiKey, (req, res) =>
  sendArchived(res, () => getRecord(String(req.params.id)), readBundle, r => `${r.title}-bundle.json`, 'application/json'),
);

app.get('/api/documents/:id/pdf', requireApiKey, (req, res) =>
  sendArchived(res, () => getRecord(String(req.params.id)), readPdf, r => r.filename, 'application/pdf'),
);

async function verifyArchived(
  res: express.Response,
  load: () => Promise<ArchiveRecord | undefined>,
  uploaded?: Buffer,
): Promise<void> {
  let bundle: unknown;
  let pdfBuffer: Buffer | null = null;
  try {
    const record = await load();
    const bundleBytes = record ? await readBundle(record.id) : null;
    pdfBuffer = uploaded ?? (record ? await readPdf(record.id) : null);
    if (!record || !bundleBytes || !pdfBuffer) {
      res.status(404).json({ valid: false, steps: [], signers: [], error: 'document not found' });
      return;
    }
    bundle = JSON.parse(bundleBytes.toString('utf8'));
  } catch (e) {
    console.error(`load archive files failed: ${(e as Error).message}`);
    res.status(500).json({ valid: false, steps: [], signers: [], error: 'could not load archived files' });
    return;
  }

  try {
    res.json(await verifyBundle(bundle, pdfBuffer as Buffer, verifyOptions));
  } catch (e) {
    console.error(`verify failed: ${(e as Error).message}`);
    res.status(500).json({ valid: false, steps: [], signers: [], error: 'verification failed due to an internal error' });
  }
}

app.post('/api/documents/:id/verify', verifyLimiter, requireApiKey, upload.single('pdf'), (req, res) =>
  verifyArchived(res, () => getRecord(String(req.params.id)), req.file?.buffer),
);

// Issue (or reissue, revoking the old one) the signer link for a record.
app.post('/api/documents/:id/share', archiveLimiter, requireApiKey, async (req, res) => {
  try {
    const token = await rotateShareToken(String(req.params.id));
    if (!token) {
      res.status(404).json({ error: 'document not found' });
      return;
    }
    res.json({ path: `/d/${token}` });
  } catch (e) {
    console.error(`share link failed: ${(e as Error).message}`);
    res.status(500).json({ error: 'could not create signer link' });
  }
});

// ---------------------------------------------------------------------------
// Signer links: the token in the URL is the only credential. Responses are
// never cached or indexed, and expose the SharedDocument summary only.
// ---------------------------------------------------------------------------
function noStore(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}
const shared = [verifyLimiter, noStore];
const sharedRecord = (req: express.Request) => () => resolveShareToken(String(req.params.token));

app.get('/d/:token', shared, (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'share.html')));

app.get('/api/shared/:token', shared, async (req, res) => {
  try {
    const record = await sharedRecord(req)();
    if (!record) {
      res.status(404).json({ error: 'link not found or revoked' });
      return;
    }
    res.json(sharedView(record));
  } catch (e) {
    console.error(`shared lookup failed: ${(e as Error).message}`);
    res.status(500).json({ error: 'could not load document' });
  }
});

app.get('/api/shared/:token/bundle', shared, (req, res) =>
  sendArchived(res, sharedRecord(req), readBundle, r => `${r.title}-bundle.json`, 'application/json'),
);

app.get('/api/shared/:token/pdf', shared, (req, res) =>
  sendArchived(res, sharedRecord(req), readPdf, r => r.filename, 'application/pdf'),
);

app.post('/api/shared/:token/verify', shared, (req, res) => verifyArchived(res, sharedRecord(req)));

// POST /api/anchor — agent-friendly JSON endpoint for hash anchoring.
// Accepts { hash, envelope_id?, signers? }, returns a proof bundle.
//
// Order matters: the request is validated and the issuer checked BEFORE the
// paywall settles the payment, so a client is never charged for a request
// that cannot succeed. A request without a payment header skips validation
// and gets the 402 payment instructions.
interface AnchorInput {
  hash: string;
  envelopeId: string;
  signers: Signer[];
}

function parseAnchorRequest(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const body = (req.body ?? {}) as { hash?: unknown; envelope_id?: unknown; signers?: unknown };
  const hasPayment = Boolean(req.header('payment-signature'));
  const fail = (error: string) => {
    if (hasPayment || !process.env.X402_TREASURY_ADDRESS) res.status(400).json({ error });
    else next();
  };

  const hash = body.hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    fail('hash must be a 64-character lowercase hex SHA-256 string');
    return;
  }
  let envelopeId = `doc-${Date.now()}`;
  if (body.envelope_id !== undefined) {
    const valid = validateEnvelopeId(body.envelope_id);
    if (!valid) {
      fail('envelope_id must be 1-128 characters of [A-Za-z0-9._:-]');
      return;
    }
    envelopeId = valid;
  }
  const checked = validateSigners(body.signers);
  if ('error' in checked) {
    fail(checked.error);
    return;
  }
  res.locals.anchorInput = { hash, envelopeId, signers: checked.signers } satisfies AnchorInput;
  next();
}

const anchorPaywall: express.RequestHandler = process.env.X402_TREASURY_ADDRESS
  ? requireAnchorPayment()
  : (_req, _res, next) => next();

app.post(
  '/api/anchor',
  anchorLimiter,
  express.json({ limit: '64kb' }),
  parseAnchorRequest,
  requireIssuerReady,
  anchorPaywall,
  async (req, res) => {
    const input = res.locals.anchorInput as AnchorInput | undefined;
    if (!input) {
      res.status(400).json({ error: 'hash must be a 64-character lowercase hex SHA-256 string' });
      return;
    }
    try {
      const bundle = await createProofBundle({
        documentHash: input.hash,
        envelopeId: input.envelopeId,
        signers: input.signers,
        signerSource: 'requester-asserted',
      });
      await markPaymentFulfilled(res);

      console.log(
        JSON.stringify({
          event: 'anchor',
          hash: input.hash,
          envelopeId: input.envelopeId,
          algorandTxnId: bundle.algorandTxnId,
          round: bundle.algorandRound,
          timestamp: new Date().toISOString(),
          ip: req.ip,
        }),
      );

      res.json({ success: true, algorandTxnId: bundle.algorandTxnId, algorandRound: bundle.algorandRound, bundle });
    } catch (e) {
      console.error(`anchor failed: ${(e as Error).message}`);
      res.status(500).json({
        error: 'anchor failed due to an internal error',
        ...(res.locals.paymentKey
          ? {
              paymentSettled: true,
              retry: 'Your payment was settled. Resend the same request with the same payment-signature header after 30 seconds to receive your bundle.',
            }
          : {}),
      });
    }
  },
);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'file too large for server upload (max 4 MB) — use the in-browser verifier or the CLI for larger documents'
        : 'invalid upload';
    res.status(400).json({ valid: false, steps: [], signers: [], error: message });
    return;
  }
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ valid: false, steps: [], signers: [], error: 'bad request' });
    return;
  }
  console.error(`unhandled error: ${err.message}`);
  res.status(500).json({ valid: false, steps: [], signers: [], error: 'internal error' });
});

if (!process.env.DOCUSIGN_HMAC_KEY) {
  process.stderr.write('warn: DOCUSIGN_HMAC_KEY not set — all webhook requests will be rejected\n');
}

export default app;
