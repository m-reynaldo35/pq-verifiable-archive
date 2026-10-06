import { randomUUID } from 'node:crypto';
import { getStorage } from './storage.js';

// Small durable state machine on top of Storage.claim, shared by the payment
// flow (payments/<txid>) and the DocuSign webhook (webhooks/<envelope>).

export interface ClaimState {
  state: string;
  at: number;
  nonce: string;
}

export type ClaimResult = { fresh: true; nonce: string } | { fresh: false; current: ClaimState | null };

function encode(state: string, nonce: string): string {
  return JSON.stringify({ state, at: Date.now(), nonce });
}

export async function readClaim(key: string): Promise<ClaimState | null> {
  const raw = await getStorage().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as ClaimState;
  } catch {
    // Pre-JSON claims (plain timestamps) are treated as completed.
    return { state: 'done', at: 0, nonce: '' };
  }
}

export async function tryClaim(key: string, state: string): Promise<ClaimResult> {
  const nonce = randomUUID();
  if (await getStorage().claim(key, encode(state, nonce))) return { fresh: true, nonce };
  return { fresh: false, current: await readClaim(key) };
}

export async function setClaim(key: string, state: string): Promise<void> {
  await getStorage().put(key, encode(state, randomUUID()), 'application/json');
}

export async function releaseClaim(key: string): Promise<void> {
  await getStorage().release(key);
}
