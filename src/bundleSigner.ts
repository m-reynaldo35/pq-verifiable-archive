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
  blockTimestamp: string;
  stateProofRound: number;
  signingMetadata: {
    signers: SignerMetadata[];
  };
  docusignSigners: DocuSignSigner[];
  docusignKeyRegistrationTxnId: string;
  algorithm: 'ml-dsa-65';
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
  const message = canonicalBytes(bundle);
  const signature = ml_dsa65.sign(message, secretKey);
  return { ...bundle, signature: Buffer.from(signature).toString('hex') };
}

export function getPublicKeyBytes(): Uint8Array {
  return requireEnvHex('DOCUSIGN_MLDSA_PUBLIC_KEY');
}

export function verifyBundleSignature(bundle: ProofBundle): boolean {
  const publicKey = getPublicKeyBytes();
  const { signature, ...unsigned } = bundle;
  const message = canonicalBytes(unsigned);
  const sigBytes = Uint8Array.from(Buffer.from(signature, 'hex'));
  return ml_dsa65.verify(sigBytes, message, publicKey);
}
