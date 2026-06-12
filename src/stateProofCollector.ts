const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud';
const STATE_PROOF_INTERVAL = 256;
const POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
const ROUND_SCAN_WINDOW = 1000;

export interface StateProofData {
  stateProofRound: number;
  raw: unknown;
}

function indexerUrl(): string {
  return process.env.ALGORAND_INDEXER_URL || DEFAULT_INDEXER_URL;
}

interface IndexerStpfTransaction {
  'confirmed-round'?: number;
}

interface IndexerStpfResponse {
  transactions?: IndexerStpfTransaction[];
}

// State proofs are emitted at interval boundaries; the proof covering round R
// is the first boundary at or after R. Used only as a hint for logging/UI.
export function coveringRound(round: number): number {
  return Math.ceil(round / STATE_PROOF_INTERVAL) * STATE_PROOF_INTERVAL;
}

// Query the archival indexer for state-proof (`stpf`) transactions covering the
// given round. Each stpf txn is committed several rounds *after* the interval
// it attests — confirmed-round is NOT the attested round. The stpf covering
// round R is the one for interval k = ceil(R/256), committed at or after
// round 256k. We therefore start the query at coveringRound(round) so we find
// the right interval's proof; any stpf confirmed from there covers our round.
export async function getStateProofForRound(
  round: number,
): Promise<StateProofData | null> {
  const attestedBoundary = coveringRound(round);
  const url =
    `${indexerUrl()}/v2/transactions` +
    `?tx-type=stpf&min-round=${attestedBoundary}&max-round=${attestedBoundary + ROUND_SCAN_WINDOW}&limit=1`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`State proof query failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as IndexerStpfResponse;
  const txns = body.transactions ?? [];
  const covering = txns.find(
    t => typeof t['confirmed-round'] === 'number',
  );
  if (!covering) return null;

  // Report the attested boundary (the interval end), not the confirmed-round
  // of the commitment transaction — the latter is higher and misleading.
  return { stateProofRound: attestedBoundary, raw: covering };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function waitForStateProof(
  round: number,
  maxWaitMs: number = DEFAULT_MAX_WAIT_MS,
): Promise<StateProofData> {
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const proof = await getStateProofForRound(round);
    if (proof) return proof;
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      throw new Error(
        `State proof covering round ${round} not available within ${maxWaitMs}ms`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
