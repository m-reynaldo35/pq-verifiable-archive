import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { buildMerkleTree, getMerkleRoot, getMerkleProof } from '../src/merkleBatcher.js';
import { signBundle, ProofBundleV2, UnsignedBundleV2 } from '../src/bundleSigner.js';
import { envelopeIdsDigest } from '../src/algorandAnchor.js';
import { verifyBundle } from '../src/verifyBundle.js';
import { HOSTED_ISSUER, TrustAnchor } from '../src/config.js';

// ---- fixtures ---------------------------------------------------------------
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const txid = (c: string) => c.repeat(52);
const ISSUER = 'I'.repeat(58);
const ATTACKER = 'X'.repeat(58);
const REG_TXN = txid('R');
const ANCHOR_TXN = txid('A');
const ROUND = 50_000_000;
const ROUND_TIME = 1_780_000_000;
const PDF = Buffer.from('%PDF-1.4 test document');

const issuerKeys = ml_dsa65.keygen(new Uint8Array(32).fill(7));
const attackerKeys = ml_dsa65.keygen(new Uint8Array(32).fill(9));
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

function useKeys(keys: { publicKey: Uint8Array; secretKey: Uint8Array }, regTxn: string) {
  process.env.PQVA_MLDSA_PUBLIC_KEY = hex(keys.publicKey);
  process.env.PQVA_MLDSA_PRIVATE_KEY = hex(keys.secretKey);
  process.env.PQVA_KEY_REGISTRATION_TXN_ID = regTxn;
}

function makeBundle(overrides: Partial<UnsignedBundleV2> = {}): ProofBundleV2 {
  const documentHash = sha(PDF);
  const tree = buildMerkleTree([documentHash]);
  return signBundle({
    protocol: 'pqva/2',
    envelopeId: 'env-1',
    documentHash,
    batchId: ANCHOR_TXN,
    merkleRoot: getMerkleRoot(tree),
    merkleProof: getMerkleProof(tree, documentHash),
    algorandTxnId: ANCHOR_TXN,
    algorandRound: ROUND,
    blockTimestamp: new Date(ROUND_TIME * 1000).toISOString(),
    stateProofRound: 50_000_128,
    issuerAddress: ISSUER,
    keyRegistrationTxnId: REG_TXN,
    signers: [],
    signerSource: 'requester-asserted',
    algorithm: 'ml-dsa-65',
    ...overrides,
  });
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

type Txns = Record<string, { status?: number; body?: unknown }>;
let chain: Txns;

function anchorTxn(bundle: ProofBundleV2, patch: Record<string, unknown> = {}) {
  return {
    body: {
      transaction: {
        sender: ISSUER,
        'confirmed-round': ROUND,
        'round-time': ROUND_TIME,
        note: b64({
          protocol: 'pqva/2',
          op: 'anchor',
          merkleRoot: bundle.merkleRoot,
          envelopeCount: 1,
          envelopeIdsSha256: envelopeIdsDigest([bundle.envelopeId]),
        }),
        ...patch,
      },
    },
  };
}

function regTxn(sender: string, publicKey: Uint8Array) {
  return {
    body: {
      transaction: {
        sender,
        'confirmed-round': ROUND - 10,
        note: b64({ protocol: 'pqva/2', op: 'key-register', pkHash: `sha256:${sha(Buffer.from(publicKey))}` }),
      },
    },
  };
}

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('tx-type=stpf')) {
    return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
  }
  const id = decodeURIComponent(url.split('/v2/transactions/')[1] ?? '');
  const entry = chain[id];
  if (!entry) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(entry.body ?? {}), { status: entry.status ?? 200 });
}) as typeof fetch;

const trust: TrustAnchor = { issuerAddress: ISSUER, keyRegistrationTxnId: REG_TXN };
const opts = { trust, fetchImpl: fakeFetch, indexerUrl: 'http://indexer.test' };
const step = (r: Awaited<ReturnType<typeof verifyBundle>>, name: string) => r.steps.find(s => s.name === name)!;

beforeEach(() => {
  useKeys(issuerKeys, REG_TXN);
  chain = { [REG_TXN]: regTxn(ISSUER, issuerKeys.publicKey) };
});

// ---- tests ------------------------------------------------------------------
test('valid bundle with document', async () => {
  const bundle = makeBundle();
  chain[ANCHOR_TXN] = anchorTxn(bundle);
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, true, JSON.stringify(r.steps));
  assert.equal(r.documentChecked, true);
  assert.equal(r.anchoredAt, new Date(ROUND_TIME * 1000).toISOString());
});

test('without a document the result says the document was not checked', async () => {
  const bundle = makeBundle();
  chain[ANCHOR_TXN] = anchorTxn(bundle);
  const r = await verifyBundle(bundle, undefined, opts);
  assert.equal(r.valid, true);
  assert.equal(r.documentChecked, false);
});

test('key registration lookup failing is an error, never a pass (fail closed)', async () => {
  const bundle = makeBundle();
  chain[ANCHOR_TXN] = anchorTxn(bundle);
  chain[REG_TXN] = { status: 503 };
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, false);
  assert.equal(r.operationalError, true);
  assert.equal(step(r, 'ML-DSA-65 Signature').passed, false);
});

test('forger with own key and own registration is rejected', async () => {
  const attackerReg = txid('F');
  useKeys(attackerKeys, attackerReg);
  const bundle = makeBundle({ keyRegistrationTxnId: attackerReg });
  chain[attackerReg] = regTxn(ATTACKER, attackerKeys.publicKey);
  chain[ANCHOR_TXN] = anchorTxn(bundle, { sender: ATTACKER });
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, false);
  assert.equal(r.operationalError, false);
  assert.equal(step(r, 'ML-DSA-65 Signature').passed, false);
  assert.equal(step(r, 'Algorand Anchor').passed, false);
});

test('bundle naming a different issuer is rejected', async () => {
  const bundle = makeBundle({ issuerAddress: ATTACKER });
  chain[ANCHOR_TXN] = anchorTxn(bundle);
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, false);
});

test('anchor txn from another sender is rejected', async () => {
  const bundle = makeBundle();
  chain[ANCHOR_TXN] = anchorTxn(bundle, { sender: ATTACKER });
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, false);
  assert.match(step(r, 'Algorand Anchor').detail, /not the trusted issuer/);
});

test('anchor in a different round than claimed is rejected', async () => {
  const bundle = makeBundle();
  chain[ANCHOR_TXN] = anchorTxn(bundle, { 'confirmed-round': ROUND + 5 });
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, false);
});

test('note that merely contains the root as a substring is rejected', async () => {
  const bundle = makeBundle();
  chain[ANCHOR_TXN] = anchorTxn(bundle, {
    note: Buffer.from(`junk ${bundle.merkleRoot} junk`).toString('base64'),
  });
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, false);
});

test('tampered document is rejected', async () => {
  const bundle = makeBundle();
  chain[ANCHOR_TXN] = anchorTxn(bundle);
  const r = await verifyBundle(bundle, Buffer.from('%PDF-1.4 tampered'), opts);
  assert.equal(r.valid, false);
  assert.equal(r.operationalError, false);
});

test('tampered signed field is rejected', async () => {
  const bundle = { ...makeBundle(), signers: [{ name: 'Mallory', email: 'm@example.com', signedAt: '2026-01-01T00:00:00.000Z' }] };
  chain[ANCHOR_TXN] = anchorTxn(bundle);
  const r = await verifyBundle(bundle, PDF, opts);
  assert.equal(r.valid, false);
  assert.equal(step(r, 'ML-DSA-65 Signature').detail, 'signature mismatch');
});

test('non-object JSON is INVALID, not an operational error', async () => {
  for (const input of [null, 'x', 42, []]) {
    const r = await verifyBundle(input, undefined, opts);
    assert.equal(r.valid, false);
    assert.equal(r.operationalError, false);
  }
});

test('real pqva/1 mainnet sample bundle verifies offline-key + recorded chain data', async () => {
  const bundle = JSON.parse(readFileSync('bundles/sample-contract-bundle.json', 'utf8'));
  const pdf = readFileSync('assets/sample-contract.pdf');
  // Recorded from mainnet indexer for txn WITBLRK… (round 62053315).
  chain = {
    [bundle.algorandTxnId]: {
      body: {
        transaction: {
          sender: HOSTED_ISSUER.issuerAddress,
          'confirmed-round': 62053315,
          'round-time': 1781187628,
          note: 'eyJwcm90b2NvbCI6InBxdmEvMSIsIm9wIjoiYW5jaG9yIiwibWVya2xlUm9vdCI6IjdkZjEzZmQ3Zjk5YmFlYjAzNWU0YTU1YTQ4Mjk2YWYwN2Q0NTliZDlmMzNkMTkwZmE5YmVlZTQ0MzUwZTAzNTMiLCJlbnZlbG9wZUNvdW50IjoxLCJlbnZlbG9wZUlkc1NoYTI1NiI6IjJmZGY4NTMwMTNiNmEyNDEzODkxNWZjMzJhZTAzODFhYjk1NTM5ZWZjYmM2OGI4OTVmYTA4MTY1YTFhZDU3NGEifQ==',
        },
      },
    },
  };
  const r = await verifyBundle(bundle, pdf, { trust: HOSTED_ISSUER, fetchImpl: fakeFetch, indexerUrl: 'http://indexer.test' });
  assert.equal(r.valid, true, JSON.stringify(r.steps));
  assert.match(step(r, 'ML-DSA-65 Signature').detail, /pinned issuer key \(offline\)/);
  assert.equal(r.signerSource, 'requester-asserted');
});
