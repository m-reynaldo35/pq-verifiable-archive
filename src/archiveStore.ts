import { readFile } from 'fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { getStorage } from './storage.js';
import type { DocumentCapture, ProofBundle, Signer, SignerSource } from './bundleSigner.js';

export interface ArchiveRecord {
  id: string;
  envelopeId: string;
  title: string;
  filename: string;
  documentHash: string;
  signers: Signer[];
  signerSource: SignerSource;
  txId: string;
  round: number;
  // May be absent when the ledger round time could not be fetched.
  blockTimestamp?: string;
  stateProofRound: number;
  archivedAt: string;
  capture?: DocumentCapture;
  // Secret for the signer link (/d/<token>). Operator-only: records are never
  // served to link holders, only the SharedDocument summary below.
  shareToken?: string;
}

// What a signer link exposes: enough to identify and verify the document,
// never the share token or other operator fields.
export interface SharedDocument {
  title: string;
  filename: string;
  envelopeId: string;
  documentHash: string;
  signers: Signer[];
  signerSource: SignerSource;
  txId: string;
  round: number;
  blockTimestamp?: string;
  archivedAt: string;
  capture?: DocumentCapture;
}

// Storage layout (Vercel Blob or PQVA_ARCHIVE_DIR):
//   records/<id>.json   archive record
//   bundles/<id>.json   proof bundle
//   pdfs/<id>.pdf       archived document
//   shares/<sha256>.json signer link index: SHA-256(token) -> record id
const recordKey = (id: string) => `records/${id}.json`;
const bundleKey = (id: string) => `bundles/${id}.json`;
const pdfKey = (id: string) => `pdfs/${id}.pdf`;
const shareKey = (token: string) => `shares/${createHash('sha256').update(token).digest('hex')}.json`;

// Newest records first (ids sort that way), fetched in full, so keep this modest.
const MAX_LISTED_RECORDS = 200;
const ID_RE = /^[a-z0-9-]{1,80}$/;

// The demo sample ships with the code (read-only) instead of being copied into
// storage, so it is always present and never needs seeding.
const SAMPLE_ID = 'sample-contract';
const SAMPLE_BUNDLE_PATH = path.resolve('bundles/sample-contract-bundle.json');
const SAMPLE_PDF_PATH = path.resolve('assets/sample-contract.pdf');

async function sampleRecord(): Promise<ArchiveRecord | undefined> {
  let bundle: ProofBundle;
  try {
    bundle = JSON.parse(await readFile(SAMPLE_BUNDLE_PATH, 'utf8')) as ProofBundle;
  } catch {
    return undefined;
  }
  return {
    id: SAMPLE_ID,
    envelopeId: bundle.envelopeId,
    title: 'sample-contract',
    filename: 'sample-contract.pdf',
    documentHash: bundle.documentHash,
    signers: bundle.protocol === 'pqva/2' ? bundle.signers : bundle.docusignSigners ?? [],
    signerSource: bundle.protocol === 'pqva/2' ? bundle.signerSource : 'requester-asserted',
    txId: bundle.algorandTxnId,
    round: bundle.algorandRound,
    blockTimestamp: bundle.blockTimestamp,
    stateProofRound: bundle.stateProofRound,
    archivedAt: bundle.blockTimestamp ?? '1970-01-01T00:00:00.000Z',
  };
}

// Record ids start with a fixed-width, decreasing timestamp, so the storage
// listing (lexicographic) returns the newest records first.
const TIME_BASE = 1e13;
export function newRecordId(slug: string): string {
  const inverted = (TIME_BASE - Date.now()).toString(36).padStart(9, '0');
  return `${inverted}-${randomUUID().slice(0, 6)}-${slug}`.slice(0, 80).replace(/-+$/, '');
}

// Canonical form of a DocuSign envelope id, used for both the webhook's
// de-duplication claim and its record id so the two can never disagree.
export function webhookCanonicalId(envelopeId: string): string {
  return envelopeId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
}

export async function listRecords(): Promise<ArchiveRecord[]> {
  const storage = getStorage();
  const keys = await storage.list('records/', MAX_LISTED_RECORDS);
  const records = (
    await Promise.all(
      keys.map(async k => {
        try {
          const raw = await storage.get(k);
          return raw ? (JSON.parse(raw.toString('utf8')) as ArchiveRecord) : undefined;
        } catch (e) {
          // One unreadable record must not hide the rest of the archive.
          console.error(`skipping unreadable archive record ${k}: ${(e as Error).message}`);
          return undefined;
        }
      }),
    )
  ).filter((r): r is ArchiveRecord => Boolean(r));
  const sample = await sampleRecord();
  if (sample) records.push(sample);
  return records.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export async function getRecord(id: string): Promise<ArchiveRecord | undefined> {
  if (id === SAMPLE_ID) return sampleRecord();
  if (!ID_RE.test(id)) return undefined;
  const raw = await getStorage().get(recordKey(id));
  return raw ? (JSON.parse(raw.toString('utf8')) as ArchiveRecord) : undefined;
}

export async function readBundle(id: string): Promise<Buffer | null> {
  if (id === SAMPLE_ID) return readFile(SAMPLE_BUNDLE_PATH);
  return getStorage().get(bundleKey(id));
}

export async function readPdf(id: string): Promise<Buffer | null> {
  if (id === SAMPLE_ID) return readFile(SAMPLE_PDF_PATH);
  return getStorage().get(pdfKey(id));
}

// The record is written last, so a record is only listed once its bundle and
// PDF are in place.
export async function saveRecord(record: ArchiveRecord, bundleJson: string, pdfBuffer: Buffer): Promise<void> {
  if (!ID_RE.test(record.id)) throw new Error(`invalid archive record id: ${record.id}`);
  const storage = getStorage();
  await storage.put(bundleKey(record.id), bundleJson, 'application/json');
  await storage.put(pdfKey(record.id), pdfBuffer, 'application/pdf');
  await storage.put(recordKey(record.id), JSON.stringify(record, null, 2), 'application/json');
}

export function storageKind(): string {
  return getStorage().kind;
}

// ---------------------------------------------------------------------------
// Signer links. The archived copy is the document of record (DocuSign
// regenerates its PDFs on every download), so signers get it from here.
// A link is a 256-bit random token; the index is keyed by its hash, and the
// record must still hold the same token, so rotating a link revokes the old
// one even if deleting its index entry failed.
// ---------------------------------------------------------------------------
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

// Point `token` at the record. Call after the record (holding the token) is saved.
export async function indexShareToken(recordId: string, token: string): Promise<void> {
  await getStorage().put(shareKey(token), JSON.stringify({ recordId }), 'application/json');
}

// Issue a fresh link for a record, revoking any previous one.
export async function rotateShareToken(recordId: string): Promise<string | undefined> {
  if (recordId === SAMPLE_ID) return undefined;
  const record = await getRecord(recordId);
  if (!record) return undefined;
  const previous = record.shareToken;
  const token = newShareToken();
  const storage = getStorage();
  await storage.put(recordKey(record.id), JSON.stringify({ ...record, shareToken: token }, null, 2), 'application/json');
  await indexShareToken(record.id, token);
  if (previous && SHARE_TOKEN_RE.test(previous)) await storage.release(shareKey(previous)).catch(() => undefined);
  return token;
}

export async function resolveShareToken(token: string): Promise<ArchiveRecord | undefined> {
  if (!SHARE_TOKEN_RE.test(token)) return undefined;
  const raw = await getStorage().get(shareKey(token));
  if (!raw) return undefined;
  const { recordId } = JSON.parse(raw.toString('utf8')) as { recordId?: unknown };
  if (typeof recordId !== 'string') return undefined;
  const record = await getRecord(recordId);
  return record?.shareToken === token ? record : undefined;
}

export function sharedView(r: ArchiveRecord): SharedDocument {
  return {
    title: r.title,
    filename: r.filename,
    envelopeId: r.envelopeId,
    documentHash: r.documentHash,
    signers: r.signers,
    signerSource: r.signerSource,
    txId: r.txId,
    round: r.round,
    ...(r.blockTimestamp ? { blockTimestamp: r.blockTimestamp } : {}),
    archivedAt: r.archivedAt,
    ...(r.capture ? { capture: r.capture } : {}),
  };
}
