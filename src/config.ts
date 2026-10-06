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
  // sha256 hex of the issuer's ML-DSA-65 public key. When set it is a strict
  // pin: only this key is accepted and Step 1 needs no network. When unset,
  // any key registered on-chain by issuerAddress is accepted (key rotation).
  pkSha256?: string;
  // Bundle protocol versions this issuer may sign. Unset = any.
  protocols?: Array<'pqva/1' | 'pqva/2'>;
  // Highest anchor round accepted from this issuer (for retired issuers).
  maxRound?: number;
  // Full hex public key, used only for legacy pqva/1 bundles that predate the
  // embedded `mldsaPublicKey` field.
  publicKeyHex?: string;
}

// Issuers of the hosted service at pq-verifiable-archive.vercel.app, newest
// first. These are explicit defaults for the hosted service only; self-hosters
// configure their own issuer (see .env.example / verifier --help).
//
// Current issuer, created 2026-10-06 when the hosting moved to Vercel: key
// registration txn S7NGS2LD… (round 65727349) sent by XCJOXAMH….
export const HOSTED_ISSUER: TrustAnchor = {
  issuerAddress: 'XCJOXAMHVPXGFJHHKF3CUSVD7CD44Z4FB3BFXZYH46HYX6NUQ7TANSWAMM',
  keyRegistrationTxnId: 'S7NGS2LDQXB73R4XSSOS6VRCS66ZL3I5S7FQWXHB4YIXLDISLZ7Q',
  pkSha256: 'ede1e72e87efbd21582419e93b290d4dbeae26fe9614e4985f9bd39c4c1886ef',
  protocols: ['pqva/2'],
};

// Original issuer (Railway era), RETIRED. Trusted only for what it actually
// issued: pqva/1 bundles anchored up to round 62159611 (its last anchor, read
// from mainnet), so its old keys cannot mint new bundles that verify. Read from mainnet: txn BUVB… (round
// 62052238) sent by JJNDY3… with pkHash sha256:10dcea3c….
export const LEGACY_HOSTED_ISSUER: TrustAnchor = {
  issuerAddress: 'JJNDY3TLLBDD5RUSKIYQXCPVD3YRVQ3M6K4TRVJD2TDM4SO3VMRC7U2YYM',
  keyRegistrationTxnId: 'BUVBKZAYLHFLAX4WLD7KA7OQZAE4QYHGY3SHY3TVKVJFGQXP3IJA',
  pkSha256: '10dcea3c1e5120f25984b0bc357d6b0c25abd7f9adcea3125321320bcba07883',
  protocols: ['pqva/1'],
  maxRound: 62159611,
};

export const HOSTED_ISSUERS: TrustAnchor[] = [HOSTED_ISSUER, LEGACY_HOSTED_ISSUER];

// Trust anchor for in-process verification (HTTP server, MCP server). Uses the
// PQVA_TRUSTED_* variables when set; otherwise falls back to the hosted issuers.
export function trustAnchorFromEnv(): TrustAnchor[] {
  const issuerAddress = process.env.PQVA_TRUSTED_ISSUER_ADDRESS;
  const keyRegistrationTxnId = process.env.PQVA_TRUSTED_KEY_REG_TXN_ID;
  if (!issuerAddress && !keyRegistrationTxnId) return HOSTED_ISSUERS;
  if (!issuerAddress || !keyRegistrationTxnId) {
    throw new Error(
      'PQVA_TRUSTED_ISSUER_ADDRESS and PQVA_TRUSTED_KEY_REG_TXN_ID must be set together',
    );
  }
  return [
    {
      issuerAddress,
      keyRegistrationTxnId,
      pkSha256: process.env.PQVA_TRUSTED_PK_SHA256 || undefined,
    },
  ];
}
