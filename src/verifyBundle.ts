import algosdk from 'algosdk';
import { hashDocument } from './documentHasher.js';
import { verifyMerkleProof } from './merkleBatcher.js';
import { verifyBundleSignature, ProofBundle, DocuSignSigner } from './bundleSigner.js';
import { getStateProofForRound } from './stateProofCollector.js';

const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud';

export interface VerifyStep {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyResult {
  valid: boolean;
  steps: VerifyStep[];
  signers: DocuSignSigner[];
}

async function fetchAnchorNote(txId: string): Promise<string> {
  const indexerUrl = process.env.ALGORAND_INDEXER_URL || DEFAULT_INDEXER_URL;
  const indexer = new algosdk.Indexer('', indexerUrl, '');
  const res = (await indexer.lookupTransactionByID(txId).do()) as {
    transaction: { note?: Uint8Array };
  };
  const note = res.transaction?.note;
  if (!note) throw new Error(`anchor transaction ${txId} has no note field`);
  return Buffer.from(note).toString('utf8');
}

export async function verifyBundle(
  bundle: ProofBundle,
  pdfBuffer?: Buffer,
): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];

  // Step 1 — ML-DSA-65 signature over canonical JSON.
  try {
    const sigOk = verifyBundleSignature(bundle);
    steps.push({
      name: 'ML-DSA-65 Signature',
      passed: sigOk,
      detail: sigOk ? 'NIST FIPS-204 attestation verified offline' : 'signature mismatch',
    });
  } catch (e) {
    steps.push({
      name: 'ML-DSA-65 Signature',
      passed: false,
      detail: (e as Error).message,
    });
  }

  // Step 2 — optional PDF hash match.
  if (pdfBuffer) {
    try {
      const computed = hashDocument(pdfBuffer);
      const match = computed === bundle.documentHash;
      steps.push({
        name: 'PDF Hash',
        passed: match,
        detail: match
          ? computed
          : `computed ${computed} != bundle ${bundle.documentHash}`,
      });
    } catch (e) {
      steps.push({ name: 'PDF Hash', passed: false, detail: (e as Error).message });
    }
  }

  // Step 3 — Merkle inclusion.
  try {
    const merkleOk = verifyMerkleProof(
      bundle.merkleRoot,
      bundle.documentHash,
      bundle.merkleProof,
    );
    steps.push({
      name: 'Merkle Inclusion',
      passed: merkleOk,
      detail: merkleOk
        ? `root: ${bundle.merkleRoot.slice(0, 16)}...`
        : 'documentHash is not a leaf under the Merkle root',
    });
  } catch (e) {
    steps.push({ name: 'Merkle Inclusion', passed: false, detail: (e as Error).message });
  }

  // Step 4 — anchor transaction note contains the Merkle root.
  try {
    const note = await fetchAnchorNote(bundle.algorandTxnId);
    const anchored = note.includes(bundle.merkleRoot);
    steps.push({
      name: 'Algorand Anchor',
      passed: anchored,
      detail: anchored
        ? `${bundle.algorandTxnId} (round ${bundle.algorandRound})`
        : `anchor note does not contain merkleRoot ${bundle.merkleRoot}`,
    });
  } catch (e) {
    steps.push({ name: 'Algorand Anchor', passed: false, detail: (e as Error).message });
  }

  // Step 5 — state proof coverage (informational, never blocks valid).
  try {
    const proof = await getStateProofForRound(bundle.algorandRound);
    steps.push({
      name: 'State Proof',
      passed: true,
      detail: proof
        ? `confirmed (round ${proof.stateProofRound})`
        : 'pending (not yet generated)',
    });
  } catch (e) {
    steps.push({
      name: 'State Proof',
      passed: true,
      detail: `pending (${(e as Error).message})`,
    });
  }

  const valid = steps
    .filter(s => s.name !== 'State Proof')
    .every(s => s.passed);

  return {
    valid,
    steps,
    signers: bundle.docusignSigners ?? [],
  };
}
