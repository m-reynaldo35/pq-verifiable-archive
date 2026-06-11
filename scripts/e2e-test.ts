// Start server first: npm start
//
// Simulates a DocuSign Connect webhook end-to-end without a real DocuSign
// account. Requires DOCUSIGN_ALLOW_TEST_PDF=true on the running server so the
// inline test PDF bypasses the DocuSign download.
import 'dotenv/config';
import { createHmac } from 'crypto';
import { spawnSync } from 'child_process';
import { access } from 'fs/promises';
import { join } from 'path';

const PORT = Number(process.env.PORT ?? 3000);
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const hmacKey = process.env.DOCUSIGN_HMAC_KEY;
  if (!hmacKey) throw new Error('DOCUSIGN_HMAC_KEY not set in environment');

  const envelopeId = `e2e-${Date.now()}`;
  const fakePdf = Buffer.from(`%PDF-1.4\nPQVA e2e test document ${envelopeId}\n%%EOF`);

  const payload = JSON.stringify({
    status: 'completed',
    envelopeId,
    testPdfBase64: fakePdf.toString('base64'),
  });

  const signature = createHmac('sha256', hmacKey).update(payload).digest('base64');

  console.log(`POSTing simulated webhook for envelope ${envelopeId}...`);
  const res = await fetch(`http://localhost:${PORT}/webhook/docusign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DocuSign-Signature-1': signature,
    },
    body: payload,
  });

  if (res.status !== 200) {
    throw new Error(`webhook returned ${res.status}: ${await res.text()}`);
  }
  console.log('Webhook accepted (200). Waiting for bundle + on-chain anchor...');

  const bundlePath = join('bundles', `${envelopeId}.json`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!(await fileExists(bundlePath))) {
    if (Date.now() > deadline) {
      throw new Error(`bundle ${bundlePath} did not appear within ${POLL_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log(`Bundle written: ${bundlePath}`);

  const result = spawnSync('npx', ['tsx', 'verifier/verify.ts', '--bundle', bundlePath], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`verifier exited with code ${result.status}`);
  }

  console.log('\nE2E PASSED ✓');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
