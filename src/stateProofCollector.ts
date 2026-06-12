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
// given round. Algod's /v2/stateproofs endpoint is non-archival and returns 500
// for entries older than ~30 minutes, so we use the indexer instead. A `stpf`
// transaction's `confirmed-round` is the round at which the state proof was
// committed; the proof it carries covers all rounds up to (and including) that
// point, so the first `stpf` with confirmed-round >= our round is the one that
// finalises us.
export async function getStateProofForRound(
  round: number,
): Promise<StateProofData | null> {
  const url =
    `${indexerUrl()}/v2/transactions` +
    `?tx-type=stpf&min-round=${round}&max-round=${round + ROUND_SCAN_WINDOW}&limit=1`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`State proof query failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as IndexerStpfResponse;
  const txns = body.transactions ?? [];
  const covering = txns.find(
    t => typeof t['confirmed-round'] === 'number' && (t['confirmed-round'] as number) >= round,
  );
  if (!covering) return null;

  return { stateProofRound: covering['confirmed-round'] as number, raw: covering };
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
