import { createHash } from 'crypto';
import algosdk from 'algosdk';
import { getPublicKeyBytes, getKeyRegistrationTxnId } from './bundleSigner.js';
import { DEFAULT_INDEXER_URL } from './config.js';

// Confirms, once per instance, that the configured issuer is coherent before
// the service takes money or anchors anything:
//   - ALGORAND_MNEMONIC's address sent PQVA_KEY_REGISTRATION_TXN_ID, and
//   - that registration records the fingerprint of PQVA_MLDSA_PUBLIC_KEY.
// Otherwise every bundle would be anchored, paid for, and then fail
// verification. A definite mismatch is cached; a network failure is retried
// on the next request.

export type IssuerStatus = { ok: true; address: string } | { ok: false; reason: string; retryable: boolean };

let cached: IssuerStatus | undefined;

async function check(): Promise<IssuerStatus> {
  const mnemonic = process.env.ALGORAND_MNEMONIC;
  if (!mnemonic) return { ok: false, reason: 'ALGORAND_MNEMONIC not set', retryable: false };
  let address: string;
  let regTxnId: string;
  let pkHash: string;
  try {
    address = algosdk.mnemonicToSecretKey(mnemonic.trim()).addr.toString();
    regTxnId = getKeyRegistrationTxnId();
    pkHash = 'sha256:' + createHash('sha256').update(getPublicKeyBytes()).digest('hex');
  } catch (e) {
    return { ok: false, reason: (e as Error).message, retryable: false };
  }

  const indexer = process.env.ALGORAND_INDEXER_URL || DEFAULT_INDEXER_URL;
  let txn: { sender?: string; note?: string };
  try {
    const res = await fetch(`${indexer}/v2/transactions/${encodeURIComponent(regTxnId)}`);
    if (res.status === 404) return { ok: false, reason: `key registration txn ${regTxnId} not found`, retryable: false };
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    txn = ((await res.json()) as { transaction?: typeof txn }).transaction ?? {};
  } catch (e) {
    return { ok: false, reason: `could not check key registration: ${(e as Error).message}`, retryable: true };
  }

  if (txn.sender !== address) {
    return { ok: false, reason: `key registration ${regTxnId} was sent by ${txn.sender}, not the issuer wallet ${address}`, retryable: false };
  }
  let note: { op?: unknown; pkHash?: unknown } = {};
  try {
    note = JSON.parse(Buffer.from(txn.note ?? '', 'base64').toString('utf8'));
  } catch {
    /* handled below */
  }
  if (note.op !== 'key-register' || note.pkHash !== pkHash) {
    return { ok: false, reason: `key registration ${regTxnId} does not record the configured public key`, retryable: false };
  }
  return { ok: true, address };
}

export async function issuerStatus(): Promise<IssuerStatus> {
  if (cached) return cached;
  const status = await check();
  if (status.ok || !status.retryable) cached = status;
  if (!status.ok) console.error(`issuer check failed: ${status.reason}`);
  return status;
}
