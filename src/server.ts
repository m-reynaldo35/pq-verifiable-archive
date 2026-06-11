import 'dotenv/config';
import express from 'express';
import { webhookRouter } from './webhookHandler.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = express();

app.use('/webhook/docusign', express.raw({ type: 'application/json' }));
app.use('/webhook', webhookRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`PQ Verifiable Archive bridge listening on :${PORT}`);
});
