import { MerkleTree } from 'merkletreejs';
import { createHash } from 'crypto';

const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

const TREE_OPTIONS = { sortPairs: true } as const;

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function leafBuffer(hash: string): Buffer {
  return Buffer.from(stripHexPrefix(hash), 'hex');
}

export function buildMerkleTree(hashes: string[]): MerkleTree {
  const leaves = hashes.map(leafBuffer);
  return new MerkleTree(leaves, sha256, TREE_OPTIONS);
}

export function getMerkleRoot(tree: MerkleTree): string {
  return stripHexPrefix(tree.getHexRoot());
}

export function getMerkleProof(tree: MerkleTree, hash: string): string[] {
  return tree.getHexProof(leafBuffer(hash)).map(stripHexPrefix);
}

export function verifyMerkleProof(root: string, hash: string, proof: string[]): boolean {
  const proofBuffers = proof.map(leafBuffer);
  return MerkleTree.verify(proofBuffers, leafBuffer(hash), leafBuffer(root), sha256, TREE_OPTIONS);
}
