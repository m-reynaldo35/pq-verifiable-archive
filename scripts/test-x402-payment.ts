/**
 * E2E test: real x402 USDC payment → anchor → verify
 *
 * Uses the operator/signer wallet which has USDC on mainnet.
 * Run: npx tsx scripts/test-x402-payment.ts
 */
import algosdk from 'algosdk';
import { createHash } from 'crypto';
import { toClientAvmSigner, ExactAvmScheme, ALGORAND_MAINNET_CAIP2 } from '@x402-avm/avm';
import { x402Client } from '@x402-avm/core/client';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from '@x402-avm/core/http';

const API_URL = process.env.PQVA_API_URL ?? 'https://pq-verifiable-archive-production.up.railway.app';

// Operator/signer mnemonic — address 2FBKPEID..., has USDC on mainnet
// Override with ALGO_SIGNER_MNEMONIC env var
const PAYER_MNEMONIC =
  process.env.ALGO_SIGNER_MNEMONIC ??
  'receive now tattoo motor same desert napkin scan coral transfer wing odor toy bean neglect comfort ride pig change chapter try latin olympic above spirit';

const TEST_CONTENT = `pqva-e2e-test-${Date.now()}`;
const DOCUMENT_HASH = createHash('sha256').update(TEST_CONTENT).digest('hex');

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`\n${label}... `);
  const result = await fn();
  process.stdout.write('✓\n');
  return result;
}

async function main() {
  console.log('=== PQ Verifiable Archive — E2E Payment Test ===');
  console.log(`Document hash: ${DOCUMENT_HASH}`);
  console.log(`API: ${API_URL}\n`);

  // Build x402 client with signer registered for Algorand mainnet
  const account = algosdk.mnemonicToSecretKey(PAYER_MNEMONIC);
  const privateKeyBase64 = Buffer.from(account.sk).toString('base64');
  const signer = toClientAvmSigner(privateKeyBase64);
  const scheme = new ExactAvmScheme(signer, { algodUrl: 'https://mainnet-api.algonode.cloud' });

  // x402Client wraps the scheme and adds the required `accepted` field to the payload
  const client = new x402Client();
  client.register(ALGORAND_MAINNET_CAIP2, scheme);

  console.log(`Payer: ${signer.address}`);

  // Step 1: probe /api/anchor with no payment — expect 402
  const probe = await step('1. Probe /api/anchor (expect 402)', async () => {
    const res = await fetch(`${API_URL}/api/anchor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: DOCUMENT_HASH, envelope_id: 'e2e-test-001' }),
    });
    if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);
    return res;
  });

  // Step 2: parse payment requirements from PAYMENT-REQUIRED header
  const paymentRequired = await step('2. Parse payment requirements', async () => {
    const header = probe.headers.get('payment-required');
    if (!header) throw new Error('No payment-required header in 402 response');
    const decoded = decodePaymentRequiredHeader(header);
    const req = decoded.accepts?.[0];
    if (!req) throw new Error('No accepts array in payment-required');
    console.log(`\n     Network:  ${req.network}`);
    console.log(`     Amount:   ${parseInt(req.amount) / 1e6} USDC (${req.amount} µUSDC)`);
    console.log(`     PayTo:    ${req.payTo}`);
    console.log(`     FeePayer: ${req.extra?.feePayer ?? 'none'}`);
    return decoded;
  });

  // Step 3: build complete payment payload (includes `accepted` field the server needs)
  const paymentHeader = await step('3. Build & sign x402 atomic payment payload', async () => {
    const payload = await client.createPaymentPayload(paymentRequired);
    return encodePaymentSignatureHeader(payload);
  });

  // Step 4: send payment + anchor request
  const result = await step('4. Send payment + anchor to Algorand', async () => {
    const res = await fetch(`${API_URL}/api/anchor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentHeader,
      },
      body: JSON.stringify({
        hash: DOCUMENT_HASH,
        envelope_id: 'e2e-test-001',
        signers: [{ name: 'E2E Test', email: 'test@pqva.example', signedAt: new Date().toISOString() }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anchor failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<{
      success: boolean;
      algorandTxnId: string;
      algorandRound: number;
      bundle: unknown;
    }>;
  });

  console.log(`\n     Algorand Txn: ${result.algorandTxnId}`);
  console.log(`     Round:        ${result.algorandRound}`);

  // Step 5: verify the returned bundle via multipart POST /api/verify
  await step('5. Verify proof bundle (all 5 checks)', async () => {
    const formData = new FormData();
    formData.append(
      'bundle',
      new Blob([JSON.stringify(result.bundle)], { type: 'application/json' }),
      'bundle.json',
    );
    const res = await fetch(`${API_URL}/api/verify`, { method: 'POST', body: formData });
    const data = await res.json() as {
      valid: boolean;
      steps: { name: string; passed: boolean; skipped?: boolean; detail?: string }[];
    };
    console.log(`\n     Valid: ${data.valid}`);
    for (const s of data.steps ?? []) {
      const icon = s.skipped ? '↷' : s.passed ? '✓' : '✗';
      console.log(`     ${icon} ${s.name}${s.detail ? ': ' + s.detail.slice(0, 80) : ''}`);
    }
    if (!data.valid) throw new Error('Bundle verification failed');
    return data;
  });

  console.log('\n=== RESULT: ALL CHECKS PASSED ===');
  console.log(`Explorer: https://explorer.perawallet.app/tx/${result.algorandTxnId}`);
  console.log(JSON.stringify({ algorandTxnId: result.algorandTxnId, algorandRound: result.algorandRound }, null, 2));
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
