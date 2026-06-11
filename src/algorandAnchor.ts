import algosdk from 'algosdk';
import { createHash } from 'crypto';

const DEFAULT_NODE_URL = 'https://mainnet-api.algonode.cloud';
const NOTE_LIMIT_BYTES = 1024;

export interface AnchorResult {
  txId: string;
  confirmedRound: number;
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

  return { txId: txid, confirmedRound };
}
