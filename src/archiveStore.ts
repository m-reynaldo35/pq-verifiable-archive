import { mkdir, readFile, writeFile, rename, copyFile, access } from 'fs/promises';
import path from 'node:path';
import { ProofBundle } from './bundleSigner.js';

export interface ArchiveRecord {
  id: string;
  title: string;
  filename: string;
  documentHash: string;
  signers: { name: string; email: string; signedAt: string }[];
  txId: string;
  round: number;
  blockTimestamp: string;
  stateProofRound: number;
  archivedAt: string;
}

const ARCHIVE_DIR = path.resolve('archive');
const BUNDLES_DIR = path.join(ARCHIVE_DIR, 'bundles');
const PDFS_DIR = path.join(ARCHIVE_DIR, 'pdfs');
const INDEX_PATH = path.join(ARCHIVE_DIR, 'index.json');

const SEED_BUNDLE_SRC = path.resolve('bundles/sample-contract-bundle.json');
const SEED_PDF_SRC = path.resolve('assets/sample-contract.pdf');
const SEED_ID = 'sample-contract';

let records: ArchiveRecord[] = [];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeIndexAtomic(): Promise<void> {
  const tmp = INDEX_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await rename(tmp, INDEX_PATH);
}

async function seedSample(): Promise<void> {
  if (!(await exists(SEED_BUNDLE_SRC)) || !(await exists(SEED_PDF_SRC))) {
    process.stderr.write('warn: sample contract bundle or pdf missing — archive seeded empty\n');
    return;
  }
  const bundleJson = await readFile(SEED_BUNDLE_SRC, 'utf8');
  const bundle = JSON.parse(bundleJson) as ProofBundle;

  await copyFile(SEED_BUNDLE_SRC, getBundlePath(SEED_ID));
  await copyFile(SEED_PDF_SRC, getPdfPath(SEED_ID));

  const record: ArchiveRecord = {
    id: SEED_ID,
    title: 'sample-contract',
    filename: 'sample-contract.pdf',
    documentHash: bundle.documentHash,
    signers: bundle.docusignSigners ?? [],
    txId: bundle.algorandTxnId,
    round: bundle.algorandRound,
    blockTimestamp: bundle.blockTimestamp,
    stateProofRound: bundle.stateProofRound,
    archivedAt: bundle.blockTimestamp,
  };
  records = [record];
  await writeIndexAtomic();
}

export async function initArchive(): Promise<void> {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await mkdir(BUNDLES_DIR, { recursive: true });
  await mkdir(PDFS_DIR, { recursive: true });

  if (await exists(INDEX_PATH)) {
    const raw = await readFile(INDEX_PATH, 'utf8');
    records = JSON.parse(raw) as ArchiveRecord[];
    if (records.length === 0) await seedSample();
    return;
  }
  await seedSample();
}

export function listRecords(): ArchiveRecord[] {
  return [...records].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export function getRecord(id: string): ArchiveRecord | undefined {
  return records.find(r => r.id === id);
}

export function getBundlePath(id: string): string {
  return path.join(BUNDLES_DIR, `${id}.json`);
}

export function getPdfPath(id: string): string {
  return path.join(PDFS_DIR, `${id}.pdf`);
}

export async function saveRecord(
  record: ArchiveRecord,
  bundleJson: string,
  pdfBuffer: Buffer,
): Promise<void> {
  const bundleTmp = getBundlePath(record.id) + '.tmp';
  const pdfTmp = getPdfPath(record.id) + '.tmp';
  await writeFile(bundleTmp, bundleJson, 'utf8');
  await rename(bundleTmp, getBundlePath(record.id));
  await writeFile(pdfTmp, pdfBuffer);
  await rename(pdfTmp, getPdfPath(record.id));

  records = records.filter(r => r.id !== record.id);
  records.push(record);
  await writeIndexAtomic();
}
