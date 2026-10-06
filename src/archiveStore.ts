import { mkdir, readFile, writeFile, rename, copyFile, access } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProofBundle, Signer, SignerSource } from './bundleSigner.js';

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
}

// Set PQVA_ARCHIVE_DIR to a mounted persistent volume in production. The
// container filesystem on Railway (and most PaaS hosts) is wiped on redeploy.
const ARCHIVE_DIR = path.resolve(process.env.PQVA_ARCHIVE_DIR ?? 'archive');
const BUNDLES_DIR = path.join(ARCHIVE_DIR, 'bundles');
const PDFS_DIR = path.join(ARCHIVE_DIR, 'pdfs');
const INDEX_PATH = path.join(ARCHIVE_DIR, 'index.json');

const SEED_BUNDLE_SRC = path.resolve('bundles/sample-contract-bundle.json');
const SEED_PDF_SRC = path.resolve('assets/sample-contract.pdf');
const SEED_ID = 'sample-contract';

let records: ArchiveRecord[] = [];

// Serialises writes so concurrent saves cannot interleave index updates.
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

function writeIndex(): Promise<void> {
  return writeFileAtomic(INDEX_PATH, JSON.stringify(records, null, 2));
}

async function seedSample(): Promise<void> {
  if (!(await exists(SEED_BUNDLE_SRC)) || !(await exists(SEED_PDF_SRC))) {
    process.stderr.write('warn: sample contract bundle or pdf missing — archive seeded empty\n');
    return;
  }
  const bundle = JSON.parse(await readFile(SEED_BUNDLE_SRC, 'utf8')) as ProofBundle;

  await copyFile(SEED_BUNDLE_SRC, getBundlePath(SEED_ID));
  await copyFile(SEED_PDF_SRC, getPdfPath(SEED_ID));

  records = [
    {
      id: SEED_ID,
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
      archivedAt: bundle.blockTimestamp ?? new Date().toISOString(),
    },
  ];
  await writeIndex();
}

export async function initArchive(): Promise<void> {
  if (!process.env.PQVA_ARCHIVE_DIR && process.env.RAILWAY_ENVIRONMENT_NAME) {
    process.stderr.write(
      'warn: PQVA_ARCHIVE_DIR not set — archive is on ephemeral disk and will be lost on redeploy; mount a volume\n',
    );
  }
  await mkdir(BUNDLES_DIR, { recursive: true });
  await mkdir(PDFS_DIR, { recursive: true });

  if (await exists(INDEX_PATH)) {
    records = JSON.parse(await readFile(INDEX_PATH, 'utf8')) as ArchiveRecord[];
    if (records.length === 0) await seedSample();
    return;
  }
  await seedSample();
}

export function newRecordId(slug: string): string {
  return `doc-${randomUUID().slice(0, 12)}-${slug}`;
}

export function listRecords(): ArchiveRecord[] {
  return [...records].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export function getRecord(id: string): ArchiveRecord | undefined {
  return records.find(r => r.id === id);
}

export function findRecordByEnvelopeId(envelopeId: string): ArchiveRecord | undefined {
  return records.find(r => r.envelopeId === envelopeId);
}

export function getBundlePath(id: string): string {
  return path.join(BUNDLES_DIR, `${id}.json`);
}

export function getPdfPath(id: string): string {
  return path.join(PDFS_DIR, `${id}.pdf`);
}

export function saveRecord(record: ArchiveRecord, bundleJson: string, pdfBuffer: Buffer): Promise<void> {
  return withWriteLock(async () => {
    if (records.some(r => r.id === record.id)) throw new Error(`archive record ${record.id} already exists`);
    await writeFileAtomic(getBundlePath(record.id), bundleJson);
    await writeFileAtomic(getPdfPath(record.id), pdfBuffer);
    records = [...records, record];
    await writeIndex();
  });
}
