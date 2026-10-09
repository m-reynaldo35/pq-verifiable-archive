import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { getStorage } from './storage.js';
import { recordIdForEnvelope, getRecord, webhookCanonicalId } from './archiveStore.js';

// Public "Try it" demo (/try): a visitor signs a fixed demo contract with
// DocuSign embedded signing (no email is sent), the normal Connect webhook
// anchors it, and the visitor's status page then shows their signer link.
// A second, hash-only path anchors a hash the browser computed locally.
//
// Everything here is free to the visitor, so it is off unless
// PQVA_DEMO_ENABLED=true and capped per UTC day across all instances.

export type DemoKind = 'envelope' | 'anchor';

export function demoEnabled(): boolean {
  return process.env.PQVA_DEMO_ENABLED === 'true';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export function dailyLimit(kind: DemoKind): number {
  return kind === 'envelope'
    ? positiveInt(process.env.PQVA_DEMO_ENVELOPES_PER_DAY, 25)
    : positiveInt(process.env.PQVA_DEMO_ANCHORS_PER_DAY, 100);
}

// Durable daily quota: one claim per slot (demo-quota/<day>/<kind>/<n>), so
// concurrent instances can never hand out the same slot. Starting from the
// number of slots already taken keeps this to a list plus one or two claims.
export async function takeDailySlot(kind: DemoKind, now = new Date()): Promise<boolean> {
  const limit = dailyLimit(kind);
  if (limit === 0) return false;
  const prefix = `demo-quota/${now.toISOString().slice(0, 10)}/${kind}/`;
  const storage = getStorage();
  for (let n = (await storage.list(prefix, limit)).length; n < limit; n++) {
    if (await storage.claim(`${prefix}${String(n).padStart(4, '0')}`, JSON.stringify({ at: Date.now(), nonce: randomUUID() }))) {
      return true;
    }
  }
  return false;
}

// A demo session links the visitor's browser to their envelope. The token is
// the only credential (like a signer link) and is stored hashed.
export interface DemoSession {
  envelopeId: string;
  clientUserId: string;
  signerName: string;
  signerEmail: string;
  createdAt: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sessionKey = (token: string) => `demo-sessions/${createHash('sha256').update(token).digest('hex')}.json`;

export function newDemoToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function saveDemoSession(token: string, session: DemoSession): Promise<void> {
  await getStorage().put(sessionKey(token), JSON.stringify(session), 'application/json');
}

export async function loadDemoSession(token: string): Promise<DemoSession | undefined> {
  if (!TOKEN_RE.test(token)) return undefined;
  const raw = await getStorage().get(sessionKey(token));
  return raw ? (JSON.parse(raw.toString('utf8')) as DemoSession) : undefined;
}

// 'waiting' until the webhook has archived the envelope; then the signer link.
export async function demoStatus(session: DemoSession): Promise<{ state: 'waiting' } | { state: 'done'; path: string }> {
  const recordId = await recordIdForEnvelope(webhookCanonicalId(session.envelopeId));
  const record = recordId ? await getRecord(recordId) : undefined;
  if (!record?.shareToken) return { state: 'waiting' };
  return { state: 'done', path: `/d/${record.shareToken}` };
}

// Visitors give a display name only. The email DocuSign requires is a
// placeholder on a reserved domain: embedded recipients are never emailed, and
// no real address ends up in the public bundle.
export function validateDemoName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 60) return undefined;
  // Letters, marks, digits, spaces and a little punctuation; no markup.
  return /^[\p{L}\p{M}\p{N} .,'’-]+$/u.test(name) ? name : undefined;
}

export function placeholderEmail(): string {
  return `demo-signer-${randomBytes(6).toString('hex')}@example.com`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// The fixed demo document, sent as HTML (DocuSign renders it to PDF). The
// signature is placed at the white anchor text "/pqva-sign/".
export const DEMO_SIGN_ANCHOR = '/pqva-sign/';

export function demoContractHtml(signerName: string, date: Date): string {
  const name = escapeHtml(signerName);
  const day = date.toISOString().slice(0, 10);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; margin: 48px;">
<h1 style="font-size: 20px;">Demo Agreement: PQ Verifiable Archive</h1>
<p style="color: #555;">DocuSign developer sandbox · not a binding contract · ${day}</p>
<p>This agreement is between <b>PQ Verifiable Archive</b> ("the Archive") and <b>${name}</b> ("the Signer").</p>
<ol>
<li>When this envelope is completed, the Archive downloads the completed document, including DocuSign's certificate of completion, and computes its SHA-256 hash.</li>
<li>The hash is anchored on Algorand mainnet and covered by an ML-DSA-65 (NIST FIPS-204) post-quantum signature in a proof bundle.</li>
<li>The Signer receives a private link to the archived copy, which is the document of record: a fresh download from DocuSign is regenerated and will not match the anchored hash.</li>
<li>Only hashes are written on-chain. The Signer's name appears in the archived document and proof bundle, which are reachable only through the private link.</li>
</ol>
<p>Signed by: ${name}</p>
<p style="margin-top: 32px;">Signature: <span style="color: #ffffff;">${DEMO_SIGN_ANCHOR}</span></p>
</body></html>`;
}
