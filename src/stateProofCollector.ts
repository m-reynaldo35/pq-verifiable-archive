const DEFAULT_NODE_URL = 'https://mainnet-api.algonode.cloud';
const STATE_PROOF_INTERVAL = 256;
const POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;

export interface StateProofData {
  stateProofRound: number;
  raw: unknown;
}

function nodeUrl(): string {
  return process.env.ALGORAND_NODE_URL || DEFAULT_NODE_URL;
}

// State proofs are emitted at interval boundaries; the proof covering round R
// is the first boundary at or after R.
function coveringRound(confirmedRound: number): number {
  return Math.ceil(confirmedRound / STATE_PROOF_INTERVAL) * STATE_PROOF_INTERVAL;
}

export async function getStateProofForRound(
  confirmedRound: number,
): Promise<StateProofData | null> {
  const round = coveringRound(confirmedRound);
  const res = await fetch(`${nodeUrl()}/v2/stateproofs/${round}`);

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`State proof query failed: ${res.status} ${res.statusText}`);

  const raw: unknown = await res.json();
  return { stateProofRound: round, raw };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function waitForStateProof(
  confirmedRound: number,
  maxWaitMs: number = DEFAULT_MAX_WAIT_MS,
): Promise<StateProofData> {
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const proof = await getStateProofForRound(confirmedRound);
    if (proof) return proof;
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      throw new Error(
        `State proof for round ${coveringRound(confirmedRound)} not available within ${maxWaitMs}ms`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
