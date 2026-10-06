import { createHash } from 'crypto';
import { hashDocument } from './documentHasher.js';
import { verifyMerkleProof, verifyLegacyMerkleProof } from './merkleBatcher.js';
import {
  verifyBundleSignature,
  MLDSA65_PUBLIC_KEY_BYTES,
  ProofBundle,
  Signer,
  SignerSource,
} from './bundleSigner.js';
import { envelopeIdsDigest } from './algorandAnchor.js';
import { findStateProofForRound } from './stateProofCollector.js';
import { DEFAULT_INDEXER_URL, TrustAnchor } from './config.js';
import { parseHex, isHex32 } from './hex.js';

// Tolerated difference between the bundle's blockTimestamp and the on-chain
// round time. New bundles copy the round time exactly; early pqva/1 bundles
// were a few seconds off.
const MAX_TIMESTAMP_DRIFT_SEC = 60;

export interface VerifyOptions {
  // Who the verifier trusts to issue bundles (one or several). Never taken
  // from the bundle.
  trust: TrustAnchor | TrustAnchor[];
  indexerUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface VerifyStep {
  name: string;
  passed: boolean;
  detail: string;
  skipped?: boolean;
  // Operational failure (network, missing config) — the check could not run.
  error?: boolean;
  // Informational steps never affect `valid`.
  informational?: boolean;
}

export interface VerifyResult {
  valid: boolean;
  steps: VerifyStep[];
  // Signers listed in the bundle, with where they came from. 'requester-asserted'
  // signers were typed by whoever requested the anchor and are not verified.
  signers: Signer[];
  signerSource: SignerSource;
  // False when no document was supplied, so only the bundle was verified.
  documentChecked: boolean;
  // Anchoring time from the ledger (not from the bundle), when available.
  anchoredAt?: string;
  operationalError: boolean;
}

interface IndexerTxn {
  sender?: string;
  'confirmed-round'?: number;
  'round-time'?: number;
  note?: string;
}

const STEP_SIGNATURE = 'ML-DSA-65 Signature';
const STEP_DOCUMENT = 'Document Hash';
const STEP_MERKLE = 'Merkle Inclusion';
const STEP_ANCHOR = 'Algorand Anchor';
const STEP_STATE_PROOF = 'State Proof (indexer-reported)';

function sha256hex(data: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Structural checks so later steps never operate on undefined or wrongly typed
// fields. Any problem makes the bundle INVALID (not an operational error).
function validateBundleSchema(b: unknown): string[] {
  if (!isObject(b)) return ['bundle is not a JSON object'];
  const problems: string[] = [];
  if (b.protocol !== 'pqva/1' && b.protocol !== 'pqva/2') problems.push('protocol (expected "pqva/2" or "pqva/1")');
  if (b.algorithm !== 'ml-dsa-65') problems.push('algorithm (expected "ml-dsa-65")');
  if (typeof b.signature !== 'string' || b.signature === '') problems.push('signature');
  if (typeof b.algorandTxnId !== 'string' || !/^[A-Z2-7]{52}$/.test(b.algorandTxnId)) problems.push('algorandTxnId');
  if (!Number.isSafeInteger(b.algorandRound) || (b.algorandRound as number) <= 0) problems.push('algorandRound');
  if (!isHex32(b.merkleRoot)) problems.push('merkleRoot (64 lowercase hex)');
  if (!isHex32(b.documentHash)) problems.push('documentHash (64 lowercase hex)');
  if (typeof b.envelopeId !== 'string') problems.push('envelopeId');
  if (!Array.isArray(b.merkleProof)) problems.push('merkleProof');
  // An own "__proto__" key is dropped by some copy idioms (e.g. Object.assign),
  // which would make verifiers canonicalise differently. Never legitimate.
  if (Object.keys(b).includes('__proto__')) problems.push('__proto__ key not allowed');
  if (b.blockTimestamp !== undefined && (typeof b.blockTimestamp !== 'string' || Number.isNaN(Date.parse(b.blockTimestamp)))) {
    problems.push('blockTimestamp');
  }
  if (b.protocol === 'pqva/2') {
    if (typeof b.mldsaPublicKey !== 'string') problems.push('mldsaPublicKey');
    if (typeof b.issuerAddress !== 'string') problems.push('issuerAddress');
    if (typeof b.keyRegistrationTxnId !== 'string') problems.push('keyRegistrationTxnId');
    if (!Array.isArray(b.signers)) problems.push('signers');
    if (b.signerSource !== 'docusign-connect' && b.signerSource !== 'requester-asserted') problems.push('signerSource');
  }
  return problems;
}

function bundleSigners(b: ProofBundle): { signers: Signer[]; signerSource: SignerSource } {
  if (b.protocol === 'pqva/2') return { signers: b.signers, signerSource: b.signerSource };
  // pqva/1 signer lists were caller-supplied on every path except the webhook,
  // and the bundle does not record which, so treat them as unverified.
  return { signers: b.docusignSigners ?? [], signerSource: 'requester-asserted' };
}

// Pick the trust anchor that applies to this bundle. pqva/2 bundles name their
// issuer; the bundle is still only accepted if that issuer is configured.
// pqva/1 bundles are matched by their key-registration txn.
function selectTrustAnchor(bundle: ProofBundle, anchors: TrustAnchor[]): TrustAnchor {
  const match =
    bundle.protocol === 'pqva/2'
      ? anchors.find(a => a.issuerAddress === bundle.issuerAddress)
      : anchors.find(a => a.keyRegistrationTxnId === bundle.docusignKeyRegistrationTxnId);
  return match ?? anchors[0];
}

type KeyCheck =
  | { status: 'matched'; detail: string }
  | { status: 'mismatched'; detail: string }
  | { status: 'unavailable'; detail: string };

class Indexer {
  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch) {}

  async txn(txId: string): Promise<IndexerTxn> {
    const res = await this.fetchImpl(`${this.url}/v2/transactions/${encodeURIComponent(txId)}`);
    if (res.status === 404) throw new NotFoundError(`transaction ${txId} not found`);
    if (!res.ok) throw new Error(`indexer ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { transaction?: IndexerTxn };
    if (!body.transaction) throw new NotFoundError(`transaction ${txId} not found`);
    return body.transaction;
  }
}

class NotFoundError extends Error {}

function decodeNote(txn: IndexerTxn): Record<string, unknown> | null {
  if (typeof txn.note !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(txn.note, 'base64').toString('utf8')) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Confirm the signing key belongs to the trusted issuer. Fails closed: only
// 'matched' lets Step 1 pass.
async function checkKey(
  publicKey: Uint8Array,
  bundle: ProofBundle,
  trust: TrustAnchor,
  indexer: Indexer,
): Promise<KeyCheck> {
  const fingerprint = sha256hex(publicKey);
  if (trust.pkSha256) {
    // A pinned fingerprint is strict: no on-chain lookup can add other keys.
    return fingerprint === trust.pkSha256.toLowerCase()
      ? { status: 'matched', detail: 'key fingerprint matches the pinned issuer key (offline)' }
      : { status: 'mismatched', detail: 'public key is not the pinned key of this issuer' };
  }

  // No fingerprint pinned: the issuer may have rotated keys. Accept a
  // registration txn named in the bundle only if the trusted issuer address
  // sent it.
  const regTxnId =
    (bundle.protocol === 'pqva/2' ? bundle.keyRegistrationTxnId : bundle.docusignKeyRegistrationTxnId) ||
    trust.keyRegistrationTxnId;

  let txn: IndexerTxn;
  try {
    txn = await indexer.txn(regTxnId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return { status: 'mismatched', detail: `key registration txn ${regTxnId} does not exist` };
    }
    return { status: 'unavailable', detail: `could not look up key registration (${(e as Error).message})` };
  }
  if (txn.sender !== trust.issuerAddress) {
    return { status: 'mismatched', detail: `key registration ${regTxnId} was not sent by the trusted issuer` };
  }
  const note = decodeNote(txn);
  if (!note || note.op !== 'key-register' || typeof note.pkHash !== 'string') {
    return { status: 'mismatched', detail: `txn ${regTxnId} is not a pqva key registration` };
  }
  return note.pkHash === `sha256:${fingerprint}`
    ? { status: 'matched', detail: `key registered on-chain by trusted issuer (txn ${regTxnId})` }
    : { status: 'mismatched', detail: 'public key does not match the on-chain registration' };
}

export async function verifyBundle(
  input: unknown,
  pdfBuffer: Buffer | undefined,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const anchors = Array.isArray(options.trust) ? options.trust : [options.trust];
  if (anchors.length === 0) throw new Error('no trusted issuer configured');
  const indexer = new Indexer(options.indexerUrl ?? DEFAULT_INDEXER_URL, options.fetchImpl ?? fetch);
  const steps: VerifyStep[] = [];

  const problems = validateBundleSchema(input);
  if (problems.length > 0) {
    return {
      valid: false,
      steps: [{ name: 'Bundle Schema', passed: false, detail: `Not a valid proof bundle — bad or missing: ${problems.join(', ')}` }],
      signers: [],
      signerSource: 'requester-asserted',
      documentChecked: false,
      operationalError: false,
    };
  }
  const bundle = input as ProofBundle;
  const { signers, signerSource } = bundleSigners(bundle);
  const trust = selectTrustAnchor(bundle, anchors);

  // Step 1 — ML-DSA-65 signature, and the key must belong to the trusted issuer.
  try {
    const keyHex = bundle.mldsaPublicKey ?? trust.publicKeyHex;
    if (!keyHex) {
      steps.push({
        name: STEP_SIGNATURE,
        passed: false,
        error: true,
        detail: 'legacy bundle has no embedded public key — supply the issuer public key to verify it',
      });
    } else {
      const publicKey = parseHex(keyHex, 'mldsaPublicKey', MLDSA65_PUBLIC_KEY_BYTES);
      const scopeError =
        bundle.protocol === 'pqva/2' && bundle.issuerAddress !== trust.issuerAddress
          ? `bundle issuer ${bundle.issuerAddress} is not a trusted issuer`
          : trust.protocols && !trust.protocols.includes(bundle.protocol)
            ? `issuer ${trust.issuerAddress} is only trusted for ${trust.protocols.join(', ')} bundles`
            : trust.maxRound !== undefined && bundle.algorandRound > trust.maxRound
              ? `issuer ${trust.issuerAddress} is retired; only anchors up to round ${trust.maxRound} are trusted`
              : null;
      if (scopeError) {
        steps.push({ name: STEP_SIGNATURE, passed: false, detail: scopeError });
      } else if (!verifyBundleSignature(bundle, publicKey)) {
        steps.push({ name: STEP_SIGNATURE, passed: false, detail: 'signature mismatch' });
      } else {
        const key = await checkKey(publicKey, bundle, trust, indexer);
        steps.push({
          name: STEP_SIGNATURE,
          passed: key.status === 'matched',
          ...(key.status === 'unavailable' ? { error: true } : {}),
          detail:
            key.status === 'matched'
              ? `NIST FIPS-204 signature valid · ${key.detail}`
              : `signature is valid but the key is not confirmed as the trusted issuer's: ${key.detail}`,
        });
      }
    }
  } catch (e) {
    steps.push({ name: STEP_SIGNATURE, passed: false, detail: (e as Error).message });
  }

  // Step 2 — document hash.
  if (pdfBuffer) {
    const computed = hashDocument(pdfBuffer);
    const match = computed === bundle.documentHash;
    steps.push({
      name: STEP_DOCUMENT,
      passed: match,
      detail: match
        ? computed
        : `This document does not match the anchored one — it was modified or is the wrong file (computed ${computed} != bundle ${bundle.documentHash})`,
    });
  } else {
    steps.push({
      name: STEP_DOCUMENT,
      passed: true,
      skipped: true,
      detail: 'Not checked — no document supplied, so only the bundle itself was verified',
    });
  }

  // Step 3 — Merkle inclusion.
  try {
    const ok =
      bundle.protocol === 'pqva/2'
        ? verifyMerkleProof(bundle.merkleRoot, bundle.documentHash, bundle.merkleProof)
        : verifyLegacyMerkleProof(bundle.merkleRoot, bundle.documentHash, bundle.merkleProof);
    steps.push({
      name: STEP_MERKLE,
      passed: ok,
      detail: ok ? `root: ${bundle.merkleRoot.slice(0, 16)}…` : 'documentHash is not a leaf under the Merkle root',
    });
  } catch (e) {
    steps.push({ name: STEP_MERKLE, passed: false, detail: (e as Error).message });
  }

  // Step 4 — the anchor txn exists, was sent by the trusted issuer in the
  // claimed round, and its note commits to exactly this Merkle root.
  let anchoredAt: string | undefined;
  try {
    const txn = await indexer.txn(bundle.algorandTxnId);
    const note = decodeNote(txn);
    const failures: string[] = [];
    if (txn.sender !== trust.issuerAddress) failures.push(`sender ${txn.sender ?? '?'} is not the trusted issuer`);
    if (txn['confirmed-round'] !== bundle.algorandRound) {
      failures.push(`confirmed in round ${txn['confirmed-round'] ?? '?'}, bundle claims ${bundle.algorandRound}`);
    }
    if (!note) {
      failures.push('note is missing or not JSON');
    } else {
      if (note.protocol !== bundle.protocol || note.op !== 'anchor') failures.push('note is not a pqva anchor for this protocol version');
      if (note.merkleRoot !== bundle.merkleRoot) failures.push('note merkleRoot does not match the bundle');
      if (note.envelopeCount === 1 && note.envelopeIdsSha256 !== envelopeIdsDigest([bundle.envelopeId])) {
        failures.push('note envelope digest does not match the bundle envelopeId');
      }
    }
    if (typeof txn['round-time'] === 'number') {
      anchoredAt = new Date(txn['round-time'] * 1000).toISOString();
      if (bundle.blockTimestamp) {
        const driftSec = Math.abs(Date.parse(bundle.blockTimestamp) - txn['round-time'] * 1000) / 1000;
        if (driftSec > MAX_TIMESTAMP_DRIFT_SEC) {
          failures.push(`bundle blockTimestamp is ${Math.round(driftSec)}s from the on-chain round time`);
        }
      }
    }
    steps.push({
      name: STEP_ANCHOR,
      passed: failures.length === 0,
      detail:
        failures.length === 0
          ? `${bundle.algorandTxnId} (round ${bundle.algorandRound}${anchoredAt ? `, ${anchoredAt}` : ''})`
          : `anchor txn ${bundle.algorandTxnId} rejected: ${failures.join('; ')}`,
    });
  } catch (e) {
    if (e instanceof NotFoundError) {
      steps.push({ name: STEP_ANCHOR, passed: false, detail: `anchor txn ${bundle.algorandTxnId} does not exist` });
    } else {
      steps.push({
        name: STEP_ANCHOR,
        passed: false,
        error: true,
        detail: `ledger indexer unreachable — cannot confirm on-chain record (${(e as Error).message})`,
      });
    }
  }

  // Step 5 — informational: does the indexer report a state-proof txn whose
  // attested range covers the anchor round? Not a cryptographic check.
  try {
    const sp = await findStateProofForRound(bundle.algorandRound, options.indexerUrl, options.fetchImpl);
    steps.push({
      name: STEP_STATE_PROOF,
      passed: true,
      informational: true,
      detail: sp
        ? `indexer reports a state-proof txn (round ${sp.confirmedRound}) attesting rounds ${sp.firstAttestedRound}–${sp.lastAttestedRound}; the Falcon-512 proof itself is not verified by this tool`
        : 'no state-proof txn covering this round reported yet (usually ~20 min after anchoring)',
    });
  } catch {
    steps.push({
      name: STEP_STATE_PROOF,
      passed: true,
      informational: true,
      detail: 'indexer unavailable — state-proof status unknown',
    });
  }

  const blocking = steps.filter(s => !s.informational);
  const valid = blocking.every(s => s.passed);
  const operationalError = !valid && blocking.filter(s => !s.passed).every(s => s.error);

  return {
    valid,
    steps,
    signers,
    signerSource,
    documentChecked: Boolean(pdfBuffer),
    ...(anchoredAt ? { anchoredAt } : {}),
    operationalError,
  };
}
