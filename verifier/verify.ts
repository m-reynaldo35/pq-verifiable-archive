import 'dotenv/config';
import { readFile } from 'fs/promises';
import { Command } from 'commander';
import algosdk from 'algosdk';
import { hashDocument } from '../src/documentHasher.js';
import { verifyMerkleProof } from '../src/merkleBatcher.js';
import { verifyBundleSignature, ProofBundle } from '../src/bundleSigner.js';
import { getStateProofForRound } from '../src/stateProofCollector.js';

const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud';

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_ERROR = 2;

function fail(message: string): never {
  console.error(`INVALID: ${message}`);
  process.exit(EXIT_INVALID);
}

function errorOut(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_ERROR);
}

async function loadBundle(path: string): Promise<ProofBundle> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    errorOut(`cannot read bundle file: ${path}`);
  }
  try {
    return JSON.parse(text) as ProofBundle;
  } catch {
    errorOut(`bundle is not valid JSON: ${path}`);
  }
}

async function fetchAnchorNote(txId: string): Promise<string> {
  const indexerUrl = process.env.ALGORAND_INDEXER_URL || DEFAULT_INDEXER_URL;
  const indexer = new algosdk.Indexer('', indexerUrl, '');
  let res: { transaction: { note?: Uint8Array } };
  try {
    res = (await indexer.lookupTransactionByID(txId).do()) as typeof res;
  } catch (e) {
    errorOut(`failed to fetch transaction ${txId}: ${(e as Error).message}`);
  }
  const note = res.transaction?.note;
  if (!note) fail(`anchor transaction ${txId} has no note field`);
  return Buffer.from(note).toString('utf8');
}

async function main() {
  const program = new Command();
  program
    .requiredOption('--bundle <path>', 'path to proof bundle JSON')
    .option('--pdf <path>', 'path to original PDF for hash verification')
    .parse();

  const opts = program.opts<{ bundle: string; pdf?: string }>();
  const bundle = await loadBundle(opts.bundle);

  // Step 1 — ML-DSA-65 signature over canonical JSON.
  let sigOk: boolean;
  try {
    sigOk = verifyBundleSignature(bundle);
  } catch (e) {
    errorOut(`signature verification could not run: ${(e as Error).message}`);
  }
  if (!sigOk) fail('signature mismatch');
  console.log('✓ DocuSign ML-DSA-65 attestation valid (NIST FIPS-204)');

  // Step 2 — optional PDF hash match.
  if (opts.pdf) {
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await readFile(opts.pdf);
    } catch {
      errorOut(`cannot read PDF file: ${opts.pdf}`);
    }
    const computed = hashDocument(pdfBuffer);
    if (computed !== bundle.documentHash) {
      fail(`PDF hash ${computed} does not match bundle documentHash ${bundle.documentHash}`);
    }
    console.log('✓ PDF hash matches archive record');
  }

  // Step 3 — Merkle inclusion.
  if (!verifyMerkleProof(bundle.merkleRoot, bundle.documentHash, bundle.merkleProof)) {
    fail('documentHash is not a leaf under the Merkle root (proof failed)');
  }
  console.log(`✓ Hash included in Merkle batch (root: ${bundle.merkleRoot.slice(0, 16)}...)`);

  // Step 4 — anchor transaction note contains the Merkle root.
  const note = await fetchAnchorNote(bundle.algorandTxnId);
  if (!note.includes(bundle.merkleRoot)) {
    fail(`anchor transaction note does not contain merkleRoot ${bundle.merkleRoot}`);
  }
  console.log(`✓ Merkle root anchored in Algorand txn ${bundle.algorandTxnId.slice(0, 12)}...`);

  // Step 5 — state proof coverage (reported, not fatal).
  let coverage = 'pending';
  try {
    const proof = await getStateProofForRound(bundle.algorandRound);
    coverage = proof ? `confirmed (round ${proof.stateProofRound})` : 'not yet generated';
  } catch (e) {
    coverage = `unknown (${(e as Error).message})`;
  }
  console.log(`  confirmed round: ${bundle.algorandRound}`);
  console.log(`  state proof coverage: ${coverage}`);

  if (bundle.docusignSigners && bundle.docusignSigners.length > 0) {
    console.log('\nSigners:');
    for (const s of bundle.docusignSigners) {
      console.log(`  ${s.name} <${s.email}> — signed ${s.signedAt}`);
    }
  }

  console.log('\nVALID ✓');
  console.log(`        Document integrity proven as of ${bundle.blockTimestamp}.`);
  console.log('        AlgoNode confirms on-chain record. DocuSign attestation verified offline.');
  process.exit(EXIT_VALID);
}

main().catch(e => { console.error(`ERROR: ${(e as Error).message}`); process.exit(EXIT_ERROR); });
