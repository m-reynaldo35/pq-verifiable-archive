import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { webhookRouter } from './webhookHandler.js';
import { ProofBundle } from './bundleSigner.js';
import { verifyBundle } from './verifyBundle.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = express();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use('/webhook/docusign', express.raw({ type: 'application/json' }));
app.use('/webhook', webhookRouter);

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

    let bundle: ProofBundle;
    try {
      bundle = JSON.parse(bundleFile.buffer.toString('utf8')) as ProofBundle;
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

app.listen(PORT, () => {
  console.log(`PQ Verifiable Archive bridge listening on :${PORT}`);
});
