import algosdk from 'algosdk';
import { createHash } from 'crypto';
import { hashDocument } from './documentHasher.js';
import { verifyMerkleProof } from './merkleBatcher.js';
import {
  verifyBundleSignature,
  getPublicKeyBytes,
  ProofBundle,
  DocuSignSigner,
} from './bundleSigner.js';
import { getStateProofForRound } from './stateProofCollector.js';

const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud';

export interface VerifyStep {
  name: string;
  passed: boolean;
  detail: string;
  skipped?: boolean;
  error?: boolean;
}

export interface VerifyResult {
  valid: boolean;
  steps: VerifyStep[];
  signers: DocuSignSigner[];
  operationalError?: boolean;
}

interface IndexerTransaction {
  note?: Uint8Array;
  roundTime?: number;
}

function getIndexer(): algosdk.Indexer {
  const indexerUrl = process.env.ALGORAND_INDEXER_URL || DEFAULT_INDEXER_URL;
  return new algosdk.Indexer('', indexerUrl, '');
}

async function fetchTransaction(txId: string): Promise<IndexerTransaction> {
  const res = (await getIndexer().lookupTransactionByID(txId).do()) as {
    transaction: IndexerTransaction;
  };
  if (!res.transaction) throw new Error(`transaction ${txId} not found`);
  return res.transaction;
}

function sha256hex(data: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

// Sub-check for step 1: confirm the env public key matches the pkHash recorded
// in the on-chain key registration transaction note.
// Returns: matched | mismatched | unavailable (network/parse failure).
async function checkKeyRegistration(
  bundle: ProofBundle,
): Promise<'matched' | 'mismatched' | 'unavailable'> {
  if (!bundle.docusignKeyRegistrationTxnId) return 'unavailable';
  let note: string;
  try {
    const txn = await fetchTransaction(bundle.docusignKeyRegistrationTxnId);
    if (!txn.note) return 'unavailable';
    note = Buffer.from(txn.note).toString('utf8');
  } catch {
    return 'unavailable';
  }
  let pkHash: unknown;
  try {
    pkHash = (JSON.parse(note) as { pkHash?: unknown }).pkHash;
  } catch {
    return 'unavailable';
  }
  if (typeof pkHash !== 'string') return 'unavailable';
  const expected = 'sha256:' + sha256hex(getPublicKeyBytes());
  return pkHash === expected ? 'matched' : 'mismatched';
}

export async function verifyBundle(
  bundle: ProofBundle,
  pdfBuffer?: Buffer,
): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  let operationalError = false;

  // Step 1 — ML-DSA-65 signature over canonical JSON, plus on-chain key
  // registration confirmation.
  if (!process.env.DOCUSIGN_MLDSA_PUBLIC_KEY) {
    operationalError = true;
    steps.push({
      name: 'ML-DSA-65 Signature',
      passed: false,
      error: true,
      detail: 'DOCUSIGN_MLDSA_PUBLIC_KEY not configured',
    });
  } else {
    try {
      const sigOk = verifyBundleSignature(bundle);
      if (!sigOk) {
        steps.push({
          name: 'ML-DSA-65 Signature',
          passed: false,
          detail: 'signature mismatch',
        });
      } else {
        const reg = await checkKeyRegistration(bundle);
        if (reg === 'mismatched') {
          steps.push({
            name: 'ML-DSA-65 Signature',
            passed: false,
            detail: 'public key does not match on-chain registration',
          });
        } else {
          const regDetail =
            reg === 'matched'
              ? 'key registration confirmed on-chain'
              : 'key registration check failed (network)';
          steps.push({
            name: 'ML-DSA-65 Signature',
            passed: true,
            detail: `NIST FIPS-204 attestation verified offline · ${regDetail}`,
          });
        }
      }
    } catch (e) {
      steps.push({
        name: 'ML-DSA-65 Signature',
        passed: false,
        detail: (e as Error).message,
      });
    }
  }

  // Step 2 — PDF hash match (or informational skip when no PDF supplied).
  if (pdfBuffer) {
    try {
      const computed = hashDocument(pdfBuffer);
      const match = computed === bundle.documentHash;
      steps.push({
        name: 'PDF Hash',
        passed: match,
        detail: match
          ? computed
          : `This PDF does not match the archived document — it has been modified or is the wrong file (computed ${computed} != bundle ${bundle.documentHash})`,
      });
    } catch (e) {
      steps.push({ name: 'PDF Hash', passed: false, detail: (e as Error).message });
    }
  } else {
    steps.push({
      name: 'PDF Hash',
      passed: true,
      skipped: true,
      detail: 'Not checked — upload the original PDF to verify document integrity',
    });
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
    const txn = await fetchTransaction(bundle.algorandTxnId);
    if (!txn.note) throw new Error(`anchor transaction ${bundle.algorandTxnId} has no note field`);
    const note = Buffer.from(txn.note).toString('utf8');
    const anchored = note.includes(bundle.merkleRoot);
    const anchorTime =
      typeof txn.roundTime === 'number'
        ? new Date(txn.roundTime * 1000).toISOString()
        : undefined;
    steps.push({
      name: 'Algorand Anchor',
      passed: anchored,
      detail: anchored
        ? `${bundle.algorandTxnId} (round ${bundle.algorandRound}${anchorTime ? `, ${anchorTime}` : ''})`
        : `anchor note does not contain merkleRoot ${bundle.merkleRoot}`,
    });
  } catch (e) {
    operationalError = true;
    steps.push({
      name: 'Algorand Anchor',
      passed: false,
      error: true,
      detail: `AlgoNode unreachable — cannot confirm on-chain record (${(e as Error).message})`,
    });
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
  } catch {
    steps.push({
      name: 'State Proof',
      passed: true,
      detail: 'pending — ledger API temporarily unavailable',
    });
  }

  const valid = steps
    .filter(s => s.name !== 'State Proof')
    .every(s => s.passed);

  return {
    valid,
    steps,
    signers: bundle.docusignSigners ?? [],
    operationalError,
  };
}
