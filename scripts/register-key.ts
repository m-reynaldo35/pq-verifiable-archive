import algosdk from 'algosdk';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { randomBytes } from '@noble/post-quantum/utils.js';
import { createHash } from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const mnemonic = process.env.ALGORAND_MNEMONIC;
  if (!mnemonic) throw new Error('ALGORAND_MNEMONIC not set in .env');

  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const algodUrl = process.env.ALGONODE_ALGOD || 'https://mainnet-api.algonode.cloud';
  const algod = new algosdk.Algodv2('', algodUrl, '');

  // Generate ML-DSA key pair
  const seed = randomBytes(32);
  const keys = ml_dsa65.keygen(seed);
  const publicKeyHex = Buffer.from(keys.publicKey).toString('hex');
  const privateKeyHex = Buffer.from(keys.secretKey).toString('hex');

  // Fingerprint only goes on-chain — full public key lives in bundle + .env
  // ML-DSA-65 public key is 1952 bytes, far over the 1024-byte note limit
  const pkHash = 'sha256:' + createHash('sha256').update(keys.publicKey).digest('hex');

  // Build registration note — ~120 bytes
  const note = JSON.stringify({
    protocol: 'pqva/1',
    op: 'key-register',
    v: 1,
    alg: 'ml-dsa-65',
    pkHash,
  });

  if (Buffer.byteLength(note) > 1024) throw new Error('Note exceeds 1024 bytes');

  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    note: new TextEncoder().encode(note),
    suggestedParams: sp,
  });

  const signed = txn.signTxn(account.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 4);

  console.log('=== ML-DSA Key Registered on Algorand ===');
  console.log('Txn ID  :', txid);
  console.log('Explorer: https://explorer.perawallet.app/tx/' + txid);
  console.log('PK Hash :', pkHash);
  console.log('');
  console.log('Add to .env:');
  console.log(`DOCUSIGN_MLDSA_PUBLIC_KEY="${publicKeyHex}"`);
  console.log(`DOCUSIGN_MLDSA_PRIVATE_KEY="${privateKeyHex}"`);
  console.log(`DOCUSIGN_KEY_REGISTRATION_TXN_ID="${txid}"`);
}

main().catch(e => { console.error(e); process.exit(1); });
