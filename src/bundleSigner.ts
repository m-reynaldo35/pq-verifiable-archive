import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import canonicalize from 'canonicalize';
import type { MerkleStep } from './merkleBatcher.js';
import { envAlias } from './config.js';
import { parseHex } from './hex.js';

export const MLDSA65_PUBLIC_KEY_BYTES = 1952;
export const MLDSA65_SECRET_KEY_BYTES = 4032;
export const MLDSA65_SIGNATURE_BYTES = 3309;

export interface Signer {
  name: string;
  email: string;
  signedAt: string;
}

// Where the signer list came from. Only 'docusign-connect' signers were read
// from DocuSign's API after an HMAC-verified Connect webhook; everything else
// is whatever the requester typed and is NOT verified by the issuer.
export type SignerSource = 'docusign-connect' | 'requester-asserted';

// Where the archived document came from. documentHash covers the exact bytes
// the issuer captured. DocuSign regenerates PDF metadata, the PDF /ID and its
// own seal on every download, so a later download from DocuSign never matches:
// the archived copy is the document of record.
export interface DocumentCapture {
  source: 'docusign-envelope-combined';
  // Envelope completion time as reported by DocuSign's envelope API.
  envelopeCompletedAt: string;
  // When the issuer downloaded the completed document from DocuSign.
  capturedAt: string;
}

export interface ProofBundleV2 {
  protocol: 'pqva/2';
  envelopeId: string;
  documentHash: string;
  batchId: string;
  merkleRoot: string;
  merkleProof: MerkleStep[];
  algorandTxnId: string;
  algorandRound: number;
  // Ledger round time of the anchor txn. Omitted if it could not be fetched —
  // a local-clock fallback is never signed. Verifiers use the on-chain round
  // time as the authoritative anchoring time.
  blockTimestamp?: string;
  // First state-proof interval boundary at or after algorandRound (a hint only).
  stateProofRound: number;
  issuerAddress: string;
  keyRegistrationTxnId: string;
  signers: Signer[];
  signerSource: SignerSource;
  capture?: DocumentCapture;
  algorithm: 'ml-dsa-65';
  mldsaPublicKey: string;
  signature: string;
}

// Legacy shape, accepted by the verifier only.
export interface ProofBundleV1 {
  protocol: 'pqva/1';
  envelopeId: string;
  documentHash: string;
  batchId: string;
  merkleRoot: string;
  merkleProof: string[];
  algorandTxnId: string;
  algorandRound: number;
  blockTimestamp?: string;
  stateProofRound: number;
  signingMetadata?: { signers: unknown[] };
  docusignSigners?: Signer[];
  docusignKeyRegistrationTxnId?: string;
  algorithm: 'ml-dsa-65';
  mldsaPublicKey?: string;
  signature: string;
}

export type ProofBundle = ProofBundleV1 | ProofBundleV2;

export type UnsignedBundleV2 = Omit<ProofBundleV2, 'signature' | 'mldsaPublicKey'>;

function canonicalBytes(value: unknown): Uint8Array {
  const json = canonicalize(value);
  if (json === undefined) throw new Error('Bundle is not JCS-serializable');
  return new TextEncoder().encode(json);
}

function requireKeyHex(primary: string, legacy: string, bytes: number): Uint8Array {
  const hex = envAlias(primary, legacy);
  if (!hex) throw new Error(`${primary} not set in environment`);
  return parseHex(hex.trim(), primary, bytes);
}

export function getPublicKeyBytes(): Uint8Array {
  return requireKeyHex('PQVA_MLDSA_PUBLIC_KEY', 'DOCUSIGN_MLDSA_PUBLIC_KEY', MLDSA65_PUBLIC_KEY_BYTES);
}

function getSecretKeyBytes(): Uint8Array {
  return requireKeyHex('PQVA_MLDSA_PRIVATE_KEY', 'DOCUSIGN_MLDSA_PRIVATE_KEY', MLDSA65_SECRET_KEY_BYTES);
}

export function getKeyRegistrationTxnId(): string {
  const id = envAlias('PQVA_KEY_REGISTRATION_TXN_ID', 'DOCUSIGN_KEY_REGISTRATION_TXN_ID');
  if (!id) throw new Error('PQVA_KEY_REGISTRATION_TXN_ID not set in environment');
  return id;
}

// Sign-then-verify once with the configured key pair. Catches a public key that
// does not belong to the private key (every bundle would otherwise silently
// fail verification) before the service accepts any requests.
export function assertSigningKeysConsistent(): void {
  const sk = getSecretKeyBytes();
  const pk = getPublicKeyBytes();
  getKeyRegistrationTxnId();
  const probe = new TextEncoder().encode('pqva key self-test');
  const sig = ml_dsa65.sign(probe, sk);
  if (!ml_dsa65.verify(sig, probe, pk)) {
    throw new Error('PQVA_MLDSA_PUBLIC_KEY does not match PQVA_MLDSA_PRIVATE_KEY');
  }
}

export function signBundle(bundle: UnsignedBundleV2): ProofBundleV2 {
  const secretKey = getSecretKeyBytes();
  // The public key is part of the canonical signed payload, so a verifier can
  // check the signature from the bundle alone and then pin the key's
  // fingerprint against its configured trust anchor.
  const withKey = {
    ...bundle,
    mldsaPublicKey: Buffer.from(getPublicKeyBytes()).toString('hex'),
  };
  const signature = ml_dsa65.sign(canonicalBytes(withKey), secretKey);
  return { ...withKey, signature: Buffer.from(signature).toString('hex') };
}

// Verify the ML-DSA-65 signature over every field except `signature`, using
// the given public key. Throws on malformed hex.
export function verifyBundleSignature(bundle: ProofBundle, publicKey: Uint8Array): boolean {
  const { signature, ...unsigned } = bundle;
  const sigBytes = parseHex(signature, 'signature', MLDSA65_SIGNATURE_BYTES);
  return ml_dsa65.verify(sigBytes, canonicalBytes(unsigned), publicKey);
}
