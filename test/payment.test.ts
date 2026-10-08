import { test } from 'node:test';
import assert from 'node:assert/strict';
import algosdk from 'algosdk';
import { canonicalPaymentId, x402DiscoveryDocument } from '../src/anchorPaywall.js';

function signedPayment(): { b64: string; txid: string } {
  const acct = algosdk.generateAccount();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: acct.addr,
    receiver: acct.addr,
    amount: 0,
    suggestedParams: {
      fee: 1000,
      flatFee: true,
      firstValid: 1,
      lastValid: 1000,
      genesisHash: Buffer.alloc(32, 1),
      genesisID: 'test',
      minFee: 1000,
    },
  });
  return { b64: Buffer.from(txn.signTxn(acct.sk)).toString('base64'), txid: txn.txID() };
}

test('canonical payment id is the payment txn id, independent of encoding', () => {
  const { b64, txid } = signedPayment();
  const unpadded = b64.replace(/=+$/, '');
  assert.equal(canonicalPaymentId({ payload: { paymentGroup: ['x', b64], paymentIndex: 1 } }), txid);
  assert.equal(canonicalPaymentId({ payload: { paymentGroup: ['x', unpadded], paymentIndex: 1 } }), txid);
  // Re-serialised outer JSON (different key order) yields the same id.
  assert.equal(canonicalPaymentId({ payload: { paymentIndex: 1, paymentGroup: ['x', b64] } }), txid);
});

test('malformed payment payloads have no id', () => {
  assert.equal(canonicalPaymentId({ payload: {} }), null);
  assert.equal(canonicalPaymentId({ payload: { paymentGroup: ['garbage'], paymentIndex: 0 } }), null);
  assert.equal(canonicalPaymentId({ payload: { paymentGroup: [], paymentIndex: 3 } }), null);
});

test('x402 discovery document lists the paid anchor endpoint', () => {
  const doc = x402DiscoveryDocument();
  assert.equal(doc.version, 1);
  assert.equal(doc.resources.length, 1);
  assert.match(doc.resources[0], /^https:\/\/.+\/api\/anchor$/);
});
