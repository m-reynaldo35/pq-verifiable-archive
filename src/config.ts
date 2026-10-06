// Central place for environment lookups and the verifier trust anchor.
//
// Env var names were originally prefixed DOCUSIGN_* even though the keys are
// held by whoever operates this service, not by DocuSign. The PQVA_* names are
// now canonical; the DOCUSIGN_* names are still read as deprecated aliases so
// existing deployments keep working.

const warned = new Set<string>();

export function envAlias(primary: string, legacy?: string): string | undefined {
  const value = process.env[primary];
  if (value) return value;
  if (legacy && process.env[legacy]) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      process.stderr.write(`warn: ${legacy} is deprecated — rename it to ${primary}\n`);
    }
    return process.env[legacy];
  }
  return undefined;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud';

// Who a verifier trusts to have issued a bundle. This is configured by the
// verifier, never read from the bundle being verified.
export interface TrustAnchor {
  // Algorand address that sent the key-registration and anchor transactions.
  issuerAddress: string;
  // Transaction whose note registers the issuer's ML-DSA-65 key fingerprint.
  keyRegistrationTxnId: string;
  // sha256 hex of the issuer's ML-DSA-65 public key. When set, Step 1 is fully
  // offline; when unset, the fingerprint is read from the registration txn.
  pkSha256?: string;
  // Full hex public key, used only for legacy pqva/1 bundles that predate the
  // embedded `mldsaPublicKey` field.
  publicKeyHex?: string;
}

// The issuer behind the hosted service at
// pq-verifiable-archive.vercel.app. Values were read from
// Algorand mainnet: txn BUVB… (round 62052238) was sent by JJNDY3… with note
// {"op":"key-register","pkHash":"sha256:10dcea3c…"}.
// This is an explicit default for the hosted service only. Self-hosters must
// configure their own issuer (see .env.example / verifier --help).
export const HOSTED_ISSUER: TrustAnchor = {
  issuerAddress: 'JJNDY3TLLBDD5RUSKIYQXCPVD3YRVQ3M6K4TRVJD2TDM4SO3VMRC7U2YYM',
  keyRegistrationTxnId: 'BUVBKZAYLHFLAX4WLD7KA7OQZAE4QYHGY3SHY3TVKVJFGQXP3IJA',
  pkSha256: '10dcea3c1e5120f25984b0bc357d6b0c25abd7f9adcea3125321320bcba07883',
};

// Trust anchor for in-process verification (HTTP server, MCP server). Uses the
// PQVA_TRUSTED_* variables when set; otherwise falls back to the hosted issuer.
export function trustAnchorFromEnv(): TrustAnchor {
  const issuerAddress = process.env.PQVA_TRUSTED_ISSUER_ADDRESS;
  const keyRegistrationTxnId = process.env.PQVA_TRUSTED_KEY_REG_TXN_ID;
  if (!issuerAddress && !keyRegistrationTxnId) return HOSTED_ISSUER;
  if (!issuerAddress || !keyRegistrationTxnId) {
    throw new Error(
      'PQVA_TRUSTED_ISSUER_ADDRESS and PQVA_TRUSTED_KEY_REG_TXN_ID must be set together',
    );
  }
  return {
    issuerAddress,
    keyRegistrationTxnId,
    pkSha256: process.env.PQVA_TRUSTED_PK_SHA256 || undefined,
  };
}
