import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildMerkleTree,
  getMerkleRoot,
  getMerkleProof,
  verifyMerkleProof,
  verifyLegacyMerkleProof,
  hashLeaf,
} from '../src/merkleBatcher.js';

const h = (s: string) => createHash('sha256').update(s).digest('hex');

test('every leaf verifies for trees of 1..9 leaves', () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = Array.from({ length: n }, (_, i) => h(`doc-${n}-${i}`));
    const tree = buildMerkleTree(leaves);
    const root = getMerkleRoot(tree);
    for (const leaf of leaves) {
      assert.ok(verifyMerkleProof(root, leaf, getMerkleProof(tree, leaf)), `n=${n}`);
    }
  }
});

test('single-leaf root is the prefixed leaf hash, not the raw document hash', () => {
  const doc = h('only');
  const root = getMerkleRoot(buildMerkleTree([doc]));
  assert.notEqual(root, doc);
  assert.equal(root, hashLeaf(doc).toString('hex'));
});

test('an internal node cannot be presented as a document (domain separation)', () => {
  const leaves = [h('a'), h('b'), h('c'), h('d')];
  const tree = buildMerkleTree(leaves);
  const root = getMerkleRoot(tree);
  const internal = tree.levels[1][0].toString('hex');
  const sibling = tree.levels[1][1].toString('hex');
  assert.equal(verifyMerkleProof(root, internal, [{ side: 'right', hash: sibling }]), false);
  assert.equal(verifyMerkleProof(root, root, []), false);
});

test('a proof with a flipped side fails', () => {
  const leaves = [h('a'), h('b')];
  const tree = buildMerkleTree(leaves);
  const proof = getMerkleProof(tree, leaves[0]);
  proof[0] = { ...proof[0], side: proof[0].side === 'left' ? 'right' : 'left' };
  assert.equal(verifyMerkleProof(getMerkleRoot(tree), leaves[0], proof), false);
});

test('malformed proof hashes throw instead of being truncated', () => {
  const doc = h('x');
  assert.throws(() => verifyMerkleProof(h('r'), doc, [{ side: 'left', hash: 'zz' }]));
});

test('legacy pqva/1 batch proof from bundles/test-bundle.json still verifies', () => {
  const b = JSON.parse(readFileSync('bundles/test-bundle.json', 'utf8'));
  assert.ok(verifyLegacyMerkleProof(b.merkleRoot, b.documentHash, b.merkleProof));
  assert.equal(verifyLegacyMerkleProof(b.merkleRoot, h('other'), b.merkleProof), false);
});
