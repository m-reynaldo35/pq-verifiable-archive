import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { webhookRouter } from './webhookHandler.js';
import { ProofBundle, DocuSignSigner } from './bundleSigner.js';
import { verifyBundle } from './verifyBundle.js';
import { anchorToAlgorand } from './algorandAnchor.js';
import { buildMerkleTree, getMerkleRoot } from './merkleBatcher.js';
import { hashDocument } from './documentHasher.js';
import { assembleBundle } from './proofBundleAssembler.js';
import { StateProofData } from './stateProofCollector.js';
import {
  initArchive,
  listRecords,
  getRecord,
  saveRecord,
  getBundlePath,
  getPdfPath,
  ArchiveRecord,
} from './archiveStore.js';

const EXPLORER_TX_BASE = 'https://explorer.perawallet.app/tx/';

function slugify(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'document';
}

const PORT = Number(process.env.PORT ?? 3000);

const app = express();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use('/webhook/docusign', express.raw({ type: 'application/json' }));
app.use('/webhook', webhookRouter);

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/demo/bundle', (_req, res) => res.sendFile(path.resolve('bundles/sample-contract-bundle.json')));
app.get('/demo/pdf', (_req, res) => res.sendFile(path.resolve('assets/sample-contract.pdf')));

app.post(
  '/api/verify',
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

    const raw = bundleFile.buffer.toString('utf8');
    let bundle: ProofBundle;
    try {
      bundle = JSON.parse(raw) as ProofBundle;
    } catch {
      res.status(400).json({ valid: false, steps: [], signers: [], error: 'bundle is not valid JSON' });
      return;
    }

    const pdfBuffer = files?.pdf?.[0]?.buffer;

    try {
      const result = await verifyBundle(bundle, pdfBuffer);
      res.json(result);
    } catch (e) {
      console.error(`verify failed: ${(e as Error).message}`);
      res.status(500).json({ valid: false, steps: [], signers: [], error: (e as Error).message });
    }
  },
);

app.post('/api/archive', upload.single('pdf'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'pdf file is required' });
    return;
  }

  let signers: DocuSignSigner[];
  try {
    signers = JSON.parse((req.body as { signers?: string }).signers ?? '[]') as DocuSignSigner[];
  } catch {
    res.status(400).json({ error: 'signers field is not valid JSON' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');

  const write = (obj: unknown): void => {
    res.write(JSON.stringify(obj) + '\n');
  };

  try {
    const pdfBuffer = file.buffer;
    const documentHash = hashDocument(pdfBuffer);
    const id = `doc-${Date.now()}-${slugify(file.originalname)}`;

    write({ step: 'hash', status: 'done', detail: `sha256: ${documentHash}` });

    const tree = buildMerkleTree([documentHash]);
    const merkleRoot = getMerkleRoot(tree);
    write({ step: 'merkle', status: 'done', detail: 'batch of 1' });

    write({ step: 'anchor', status: 'running', detail: 'Anchoring to Algorand mainnet…' });

    const { txId, confirmedRound, blockTime } = await anchorToAlgorand(merkleRoot, [id]);
    const explorerUrl = EXPLORER_TX_BASE + txId;
    write({
      step: 'anchor',
      status: 'done',
      detail: `txn ${txId} · round ${confirmedRound} · ${explorerUrl}`,
    });

    const stateProof: StateProofData = {
      stateProofRound: Math.ceil(confirmedRound / 256) * 256,
      raw: null,
    };

    const bundle = assembleBundle({
      envelopeId: id,
      pdfBuffer,
      txId,
      confirmedRound,
      merkleTree: tree,
      stateProof,
      anchorTime: blockTime,
      docusignSigners: signers,
    });
    write({ step: 'sign', status: 'done', detail: 'ML-DSA-65 (NIST FIPS-204, quantum-safe)' });

    const archivedAt = new Date().toISOString();
    const record: ArchiveRecord = {
      id,
      title: slugify(file.originalname),
      filename: file.originalname,
      documentHash,
      signers,
      txId,
      round: confirmedRound,
      blockTimestamp: blockTime,
      stateProofRound: stateProof.stateProofRound,
      archivedAt,
    };
    await saveRecord(record, JSON.stringify(bundle, null, 2), pdfBuffer);
    write({ step: 'save', status: 'done', detail: 'Saved to archive' });

    write({
      step: 'stateproof',
      status: 'info',
      detail: 'pending — Falcon coverage in ~17 min (informational)',
    });

    write({ done: true, record });
    res.end();
  } catch (e) {
    const message = (e as Error).message;
    console.error(`archive failed: ${message}`);
    write({ step: 'error', status: 'error', detail: message });
    res.end();
  }
});

app.get('/api/documents', (_req, res) => {
  res.json(listRecords());
});

app.get('/api/documents/:id/bundle', (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'document not found' });
    return;
  }
  res.download(getBundlePath(record.id), `${record.title}-bundle.json`);
});

app.get('/api/documents/:id/pdf', (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'document not found' });
    return;
  }
  res.download(getPdfPath(record.id), record.filename);
});

app.post('/api/documents/:id/verify', upload.single('pdf'), async (req, res) => {
  const record = getRecord(String(req.params.id));
  if (!record) {
    res.status(404).json({ valid: false, steps: [], signers: [], error: 'document not found' });
    return;
  }

  let bundle: ProofBundle;
  try {
    const raw = await readFile(getBundlePath(record.id), 'utf8');
    bundle = JSON.parse(raw) as ProofBundle;
  } catch (e) {
    console.error(`load bundle failed: ${(e as Error).message}`);
    res.status(500).json({ valid: false, steps: [], signers: [], error: 'could not load bundle' });
    return;
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = req.file ? req.file.buffer : await readFile(getPdfPath(record.id));
  } catch (e) {
    console.error(`load pdf failed: ${(e as Error).message}`);
    res.status(500).json({ valid: false, steps: [], signers: [], error: 'could not load pdf' });
    return;
  }

  try {
    const result = await verifyBundle(bundle, pdfBuffer);
    res.json(result);
  } catch (e) {
    console.error(`verify failed: ${(e as Error).message}`);
    res.status(500).json({ valid: false, steps: [], signers: [], error: (e as Error).message });
  }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err.message.includes('File too large') ? 'file too large (max 25 MB)' : err.message;
  res.status(400).json({ valid: false, steps: [], signers: [], error: message });
});

if (!process.env.DOCUSIGN_HMAC_KEY) {
  process.stderr.write('warn: DOCUSIGN_HMAC_KEY not set — all webhook requests will be rejected\n');
}

initArchive()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PQ Verifiable Archive bridge listening on :${PORT}`);
    });
  })
  .catch(e => {
    console.error(`failed to initialize archive: ${(e as Error).message}`);
    process.exit(1);
  });
