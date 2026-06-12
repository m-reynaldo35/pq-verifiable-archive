import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import canonicalize from 'canonicalize';

export interface SignerMetadata {
  passkeyPublicKey: string;
  passkeySignature: string;
}

export interface DocuSignSigner {
  name: string;
  email: string;
  signedAt: string;
}

export interface ProofBundle {
  protocol: 'pqva/1';
  envelopeId: string;
  documentHash: string;
  batchId: string;
  merkleRoot: string;
  merkleProof: string[];
  algorandTxnId: string;
  algorandRound: number;
  // Omitted when the ledger round time could not be fetched — we never sign a
  // local-clock fallback, since the timestamp would not be ledger-backed.
  blockTimestamp?: string;
  stateProofRound: number;
  signingMetadata: {
    signers: SignerMetadata[];
  };
  docusignSigners: DocuSignSigner[];
  docusignKeyRegistrationTxnId: string;
  algorithm: 'ml-dsa-65';
  // Hex-encoded ML-DSA-65 public key, embedded so a verifier in 2050 can check
  // the signature without already holding the key. Its SHA-256 is cross-checked
  // against the on-chain pkHash registration (see verifyBundle.checkKeyRegistration).
  // Part of the canonical signed payload — set BEFORE signing.
  mldsaPublicKey?: string;
  signature: string;
}

function canonicalBytes(value: unknown): Uint8Array {
  const json = canonicalize(value);
  if (json === undefined) throw new Error('Bundle is not JCS-serializable');
  return new TextEncoder().encode(json);
}

function requireEnvHex(name: string): Uint8Array {
  const hex = process.env[name];
  if (!hex) throw new Error(`${name} not set in environment`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function signBundle(bundle: Omit<ProofBundle, 'signature'>): ProofBundle {
  const secretKey = requireEnvHex('DOCUSIGN_MLDSA_PRIVATE_KEY');
  // Embed the public key so it is part of the canonical signed payload. A
  // verifier can then check the signature against the bundle alone and confirm
  // the key against the on-chain pkHash registration.
  const withKey = {
    ...bundle,
    mldsaPublicKey: Buffer.from(getPublicKeyBytes()).toString('hex'),
  };
  const message = canonicalBytes(withKey);
  const signature = ml_dsa65.sign(message, secretKey);
  return { ...withKey, signature: Buffer.from(signature).toString('hex') };
}

export function getPublicKeyBytes(): Uint8Array {
  return requireEnvHex('DOCUSIGN_MLDSA_PUBLIC_KEY');
}

// Resolve the public key used to verify a bundle: prefer the key embedded in the
// bundle (self-describing, works for archival verification), fall back to the
// environment variable for older bundles that predate the embedded field.
export function resolvePublicKeyBytes(bundle: ProofBundle): Uint8Array {
  if (bundle.mldsaPublicKey) {
    return Uint8Array.from(Buffer.from(bundle.mldsaPublicKey, 'hex'));
  }
  return getPublicKeyBytes();
}

export function verifyBundleSignature(bundle: ProofBundle): boolean {
  const publicKey = resolvePublicKeyBytes(bundle);
  const { signature, ...unsigned } = bundle;
  const message = canonicalBytes(unsigned);
  const sigBytes = Uint8Array.from(Buffer.from(signature, 'hex'));
  return ml_dsa65.verify(sigBytes, message, publicKey);
}
