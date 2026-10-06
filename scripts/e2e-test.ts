// Start the local server first: npm run dev
//
// Simulates a DocuSign Connect 2.0 webhook end-to-end without a real DocuSign
// account. Requires DOCUSIGN_ALLOW_TEST_PDF=true on the running (non-production)
// server so the inline test PDF bypasses the DocuSign download.
import 'dotenv/config';
import algosdk from 'algosdk';
import { createHmac } from 'crypto';
import { spawnSync } from 'child_process';
import { access } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT ?? 3000);
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function requireEnv(name: string, legacy?: string): string {
  const v = process.env[name] ?? (legacy ? process.env[legacy] : undefined);
  if (!v) throw new Error(`${name} not set in environment`);
  return v;
}

async function main() {
  const hmacKey = requireEnv('DOCUSIGN_HMAC_KEY');
  const issuerAddress = algosdk.mnemonicToSecretKey(requireEnv('ALGORAND_MNEMONIC')).addr.toString();
  const keyRegTxn = requireEnv('PQVA_KEY_REGISTRATION_TXN_ID', 'DOCUSIGN_KEY_REGISTRATION_TXN_ID');

  const envelopeId = `e2e-${Date.now()}`;
  const fakePdf = Buffer.from(`%PDF-1.4\nPQVA e2e test document ${envelopeId}\n%%EOF`);

  const payload = JSON.stringify({
    event: 'envelope-completed',
    data: { envelopeId, envelopeSummary: { status: 'completed' } },
    testPdfBase64: fakePdf.toString('base64'),
  });
  const signature = createHmac('sha256', hmacKey).update(payload).digest('base64');

  console.log(`POSTing simulated webhook for envelope ${envelopeId}...`);
  const res = await fetch(`http://localhost:${PORT}/webhook/docusign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DocuSign-Signature-1': signature },
    body: payload,
  });
  if (res.status !== 200) throw new Error(`webhook returned ${res.status}: ${await res.text()}`);
  console.log('Webhook accepted (200). Waiting for bundle + on-chain anchor...');

  // Local run: the server stores in PQVA_ARCHIVE_DIR (no Blob credentials).
  const archiveDir = path.resolve(process.env.PQVA_ARCHIVE_DIR ?? 'archive');
  const id = `ds-${envelopeId.toLowerCase()}`;
  const bundlePath = path.join(archiveDir, 'bundles', `${id}.json`);
  const pdfPath = path.join(archiveDir, 'pdfs', `${id}.pdf`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!(await fileExists(bundlePath))) {
    if (Date.now() > deadline) throw new Error(`bundle ${bundlePath} did not appear within ${POLL_TIMEOUT_MS}ms`);
    await sleep(POLL_INTERVAL_MS);
  }
  console.log(`Bundle written: ${bundlePath}`);

  const result = spawnSync(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      'verifier/verify.ts',
      '--bundle', bundlePath,
      '--pdf', pdfPath,
      '--issuer-address', issuerAddress,
      '--key-reg-txn', keyRegTxn,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`verifier exited with code ${result.status}`);

  console.log('\nE2E PASSED ✓');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
