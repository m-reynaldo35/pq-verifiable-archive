import { createHash } from 'crypto';
import { parseHex } from './hex.js';

// pqva/2 Merkle tree, RFC 6962 style:
//   leaf = SHA-256(0x00 || documentHash)
//   node = SHA-256(0x01 || left || right)
// The prefixes give leaf/node domain separation, so an internal node can never
// be presented as a document hash. Pairs are ordered (not sorted) and every
// proof step records which side the sibling is on. An odd node at the end of a
// level is promoted unchanged (no duplication, so no CVE-2012-2459 issue).

export interface MerkleStep {
  side: 'left' | 'right';
  hash: string;
}

export interface MerkleTree {
  // levels[0] are the hashed leaves; the last level holds the root.
  levels: Buffer[][];
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

function hashBytes(hash: string, label: string): Buffer {
  return Buffer.from(parseHex(hash.toLowerCase(), label, 32));
}

export function hashLeaf(documentHash: string): Buffer {
  return sha256(LEAF_PREFIX, hashBytes(documentHash, 'document hash'));
}

function hashNode(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

export function buildMerkleTree(documentHashes: string[]): MerkleTree {
  if (documentHashes.length === 0) throw new Error('cannot build a Merkle tree with no leaves');
  const levels: Buffer[][] = [documentHashes.map(hashLeaf)];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashNode(prev[i], prev[i + 1]) : prev[i]);
    }
    levels.push(next);
  }
  return { levels };
}

export function getMerkleRoot(tree: MerkleTree): string {
  return tree.levels[tree.levels.length - 1][0].toString('hex');
}

export function getMerkleProof(tree: MerkleTree, documentHash: string): MerkleStep[] {
  const leaf = hashLeaf(documentHash);
  let index = tree.levels[0].findIndex(l => l.equals(leaf));
  if (index < 0) throw new Error('document hash is not a leaf of this tree');
  const proof: MerkleStep[] = [];
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const nodes = tree.levels[level];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    if (siblingIndex < nodes.length) {
      proof.push({
        side: isRight ? 'left' : 'right',
        hash: nodes[siblingIndex].toString('hex'),
      });
    }
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyMerkleProof(root: string, documentHash: string, proof: MerkleStep[]): boolean {
  if (!Array.isArray(proof)) throw new Error('merkleProof must be an array');
  let node = hashLeaf(documentHash);
  for (const step of proof) {
    if (!step || (step.side !== 'left' && step.side !== 'right')) {
      throw new Error('merkleProof step has an invalid side');
    }
    const sibling = hashBytes(step.hash, 'merkleProof hash');
    node = step.side === 'left' ? hashNode(sibling, node) : hashNode(node, sibling);
  }
  return node.equals(hashBytes(root, 'merkleRoot'));
}

// Legacy pqva/1 verification (merkletreejs with sortPairs, no leaf/node
// prefixes). Kept only so bundles issued before pqva/2 still verify; never
// used to build new trees.
export function verifyLegacyMerkleProof(root: string, documentHash: string, proof: string[]): boolean {
  if (!Array.isArray(proof)) throw new Error('merkleProof must be an array');
  let node = hashBytes(documentHash, 'document hash');
  for (const p of proof) {
    const sibling = hashBytes(String(p), 'merkleProof hash');
    const [lo, hi] = Buffer.compare(node, sibling) <= 0 ? [node, sibling] : [sibling, node];
    node = sha256(lo, hi);
  }
  return node.equals(hashBytes(root, 'merkleRoot'));
}
