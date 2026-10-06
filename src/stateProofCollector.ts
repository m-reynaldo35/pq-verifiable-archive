import { DEFAULT_INDEXER_URL } from './config.js';

const STATE_PROOF_INTERVAL = 256;
// State-proof txns for an interval are committed some rounds after it closes.
// Scan generously past the anchor round to find the one that attests it.
const ROUND_SCAN_WINDOW = 2048;

export interface StateProofSighting {
  // Round in which the state-proof (stpf) txn was confirmed.
  confirmedRound: number;
  firstAttestedRound: number;
  lastAttestedRound: number;
}

interface IndexerStpfTransaction {
  'confirmed-round'?: number;
  'state-proof-transaction'?: {
    message?: {
      'first-attested-round'?: number;
      'latest-attested-round'?: number;
    };
  };
}

// State proofs are emitted per 256-round interval; the one attesting round R
// covers the interval ending at the first boundary at or after R.
export function coveringRound(round: number): number {
  return Math.ceil(round / STATE_PROOF_INTERVAL) * STATE_PROOF_INTERVAL;
}

// Ask an indexer whether a state-proof txn attesting `round` has been
// committed, by matching the attested range in its message.
//
// IMPORTANT: this is an existence lookup that trusts the indexer's answer. It
// does NOT verify the Falcon-512 state proof itself, nor a light-block-header
// proof linking the anchor txn to it. It is reported as informational only.
export async function findStateProofForRound(
  round: number,
  indexerUrl: string = DEFAULT_INDEXER_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<StateProofSighting | null> {
  const url =
    `${indexerUrl}/v2/transactions?tx-type=stpf` +
    `&min-round=${round}&max-round=${round + ROUND_SCAN_WINDOW}&limit=20`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`state proof query failed: ${res.status} ${res.statusText}`);

  const body = (await res.json()) as { transactions?: IndexerStpfTransaction[] };
  for (const t of body.transactions ?? []) {
    const msg = t['state-proof-transaction']?.message;
    const first = msg?.['first-attested-round'];
    const last = msg?.['latest-attested-round'];
    const confirmed = t['confirmed-round'];
    if (
      typeof first === 'number' &&
      typeof last === 'number' &&
      typeof confirmed === 'number' &&
      first <= round &&
      round <= last
    ) {
      return { confirmedRound: confirmed, firstAttestedRound: first, lastAttestedRound: last };
    }
  }
  return null;
}
