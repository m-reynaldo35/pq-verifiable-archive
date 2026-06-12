import algosdk from 'algosdk';
import { createHash } from 'crypto';
import { hashDocument } from './documentHasher.js';
import { verifyMerkleProof } from './merkleBatcher.js';
import {
  verifyBundleSignature,
  resolvePublicKeyBytes,
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
  // Informational steps (e.g. the state proof) never block the overall `valid`
  // verdict — they report coverage status only.
  informational?: boolean;
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

// Minimum fields a JSON object must carry to be treated as a pqva/1 bundle.
function validateBundleSchema(bundle: ProofBundle): string[] {
  const missing: string[] = [];
  if ((bundle as { protocol?: unknown }).protocol !== 'pqva/1') missing.push('protocol (expected "pqva/1")');
  if (!bundle.signature) missing.push('signature');
  if (!bundle.algorandTxnId) missing.push('algorandTxnId');
  if (!bundle.merkleRoot) missing.push('merkleRoot');
  if (!bundle.documentHash) missing.push('documentHash');
  if ((bundle as { algorithm?: unknown }).algorithm !== 'ml-dsa-65') missing.push('algorithm (expected "ml-dsa-65")');
  return missing;
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

// Sub-check for step 1: confirm the public key used to verify the signature
// (the one embedded in the bundle, or the env key for legacy bundles) matches
// the pkHash recorded in the on-chain key registration transaction note. This
// is what lets a verifier pin only the registration txn ID (or the Algorand
// address) rather than the full key.
// Returns: matched | mismatched | unavailable (network/parse failure).
//
// TRUST MODEL NOTE: `bundle.docusignKeyRegistrationTxnId` is currently read from
// the bundle itself, which means a forger who controls the bundle could point it
// at their own registration. For a PoC this is acceptable, but in production the
// registration txn ID (or the registering Algorand address) MUST be pinned in
// the verifier out-of-band and NOT trusted from the bundle. See the caller for
// where this would be enforced.
async function checkKeyRegistration(
  bundle: ProofBundle,
  // In production, pass a pinned txn ID here instead of reading from the bundle.
  registrationTxnId: string = bundle.docusignKeyRegistrationTxnId,
): Promise<'matched' | 'mismatched' | 'unavailable'> {
  if (!registrationTxnId) return 'unavailable';
  let note: string;
  try {
    const txn = await fetchTransaction(registrationTxnId);
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
  const expected = 'sha256:' + sha256hex(resolvePublicKeyBytes(bundle));
  return pkHash === expected ? 'matched' : 'mismatched';
}

export async function verifyBundle(
  bundle: ProofBundle,
  pdfBuffer?: Buffer,
): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  let operationalError = false;

  // Schema gate — reject anything that is not a recognisable pqva/1 bundle
  // before running any checks, so we don't render "undefined" steps.
  const missing = validateBundleSchema(bundle);
  if (missing.length > 0) {
    return {
      valid: false,
      steps: [
        {
          name: 'Bundle Schema',
          passed: false,
          detail: `Not a valid pqva/1 proof bundle — missing fields: ${missing.join(', ')}`,
        },
      ],
      signers: bundle.docusignSigners ?? [],
      operationalError: false,
    };
  }

  // The public key may be embedded in the bundle (preferred) or supplied via
  // the environment for legacy bundles. Only error if neither is available.
  const hasKey = Boolean(bundle.mldsaPublicKey) || Boolean(process.env.DOCUSIGN_MLDSA_PUBLIC_KEY);

  // Step 1 — ML-DSA-65 signature over canonical JSON, plus on-chain key
  // registration confirmation.
  if (!hasKey) {
    operationalError = true;
    steps.push({
      name: 'ML-DSA-65 Signature',
      passed: false,
      error: true,
      detail: 'no ML-DSA public key available (not embedded in bundle and DOCUSIGN_MLDSA_PUBLIC_KEY not set)',
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

    // Cross-check the bundle's claimed blockTimestamp against the on-chain
    // round time. A large drift suggests the timestamp was not derived from the
    // ledger (warn only — never fails a valid anchor).
    let timeWarning = '';
    if (
      anchored &&
      bundle.blockTimestamp &&
      typeof txn.roundTime === 'number'
    ) {
      const claimed = Date.parse(bundle.blockTimestamp);
      if (!Number.isNaN(claimed)) {
        const driftSec = Math.abs(claimed - txn.roundTime * 1000) / 1000;
        if (driftSec > 60) {
          timeWarning = ` · warning: bundle blockTimestamp differs from on-chain round time by ${Math.round(driftSec)}s`;
        }
      }
    }

    steps.push({
      name: 'Algorand Anchor',
      passed: anchored,
      detail: anchored
        ? `${bundle.algorandTxnId} (round ${bundle.algorandRound}${anchorTime ? `, ${anchorTime}` : ''})${timeWarning}`
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

  // Step 5 — Falcon-512 state proof coverage (informational, never blocks valid).
  try {
    const proof = await getStateProofForRound(bundle.algorandRound);
    steps.push({
      name: 'Falcon-512 State Proof',
      passed: true,
      informational: true,
      detail: proof
        ? `confirmed — Falcon-512 state proof covers round ${proof.stateProofRound} (PQ-safe finality)`
        : 'pending — not yet generated (check back in ~1 hour)',
    });
  } catch {
    steps.push({
      name: 'Falcon-512 State Proof',
      passed: true,
      informational: true,
      detail: 'pending — ledger API temporarily unavailable',
    });
  }

  const valid = steps.filter(s => !s.informational).every(s => s.passed);

  return {
    valid,
    steps,
    signers: bundle.docusignSigners ?? [],
    operationalError,
  };
}
