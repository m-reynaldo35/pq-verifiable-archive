import algosdk from 'algosdk';
import { createHash } from 'crypto';

const DEFAULT_NODE_URL = 'https://mainnet-api.algonode.cloud';
const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud';
const NOTE_LIMIT_BYTES = 1024;

export interface AnchorResult {
  txId: string;
  confirmedRound: number;
  // Undefined when the ledger round time could not be fetched after retries —
  // callers must omit the timestamp rather than substitute a local clock.
  blockTime?: string;
}

async function fetchBlockTime(txId: string): Promise<string> {
  const indexerUrl = process.env.ALGORAND_INDEXER_URL || DEFAULT_INDEXER_URL;
  const res = await fetch(`${indexerUrl}/v2/transactions/${txId}`);
  if (!res.ok) {
    throw new Error(`indexer transaction lookup failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { transaction?: { 'round-time'?: number } };
  const roundTime = body.transaction?.['round-time'];
  if (typeof roundTime !== 'number') {
    throw new Error(`indexer response for ${txId} has no round-time`);
  }
  return new Date(roundTime * 1000).toISOString();
}

// The indexer can lag a couple of rounds behind algod; retry briefly. If it is
// still unavailable, throw rather than fall back to the local clock — we must
// never sign a timestamp that is not ledger-backed.
async function fetchBlockTimeWithRetry(txId: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetchBlockTime(txId);
    } catch (e) {
      lastError = e;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  throw new Error(
    `could not fetch ledger round time for ${txId} after retries: ${(lastError as Error)?.message ?? 'unknown'}`,
  );
}

function envelopeIdsDigest(envelopeIds: string[]): string {
  const sorted = [...envelopeIds].sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function buildNote(merkleRoot: string, envelopeIds: string[]): Uint8Array {
  const payload = {
    protocol: 'pqva/1',
    op: 'anchor',
    merkleRoot,
    envelopeCount: envelopeIds.length,
    envelopeIdsSha256: envelopeIdsDigest(envelopeIds),
  };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > NOTE_LIMIT_BYTES) {
    throw new Error(`Anchor note exceeds ${NOTE_LIMIT_BYTES} bytes`);
  }
  return new TextEncoder().encode(json);
}

export async function anchorToAlgorand(
  merkleRoot: string,
  envelopeIds: string[],
): Promise<AnchorResult> {
  const mnemonic = process.env.ALGORAND_MNEMONIC;
  if (!mnemonic) throw new Error('ALGORAND_MNEMONIC not set in environment');

  const nodeUrl = process.env.ALGORAND_NODE_URL || DEFAULT_NODE_URL;
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const algod = new algosdk.Algodv2('', nodeUrl, '');

  const note = buildNote(merkleRoot, envelopeIds);
  const suggestedParams = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    note,
    suggestedParams,
  });

  const signed = txn.signTxn(account.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  const result = await algosdk.waitForConfirmation(algod, txid, 4);
  const confirmedRound = Number(result.confirmedRound);

  // The anchor itself is confirmed; only the human-readable timestamp may be
  // missing. Omit it rather than fail the anchor or sign a local-clock value.
  let blockTime: string | undefined;
  try {
    blockTime = await fetchBlockTimeWithRetry(txid);
  } catch (e) {
    process.stderr.write(`warn: ${(e as Error).message} — omitting blockTimestamp\n`);
    blockTime = undefined;
  }

  return { txId: txid, confirmedRound, blockTime };
}
