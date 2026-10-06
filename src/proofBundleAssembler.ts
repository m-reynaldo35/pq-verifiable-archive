import { buildMerkleTree, getMerkleRoot, getMerkleProof } from './merkleBatcher.js';
import { anchorToAlgorand } from './algorandAnchor.js';
import { coveringRound } from './stateProofCollector.js';
import {
  signBundle,
  getKeyRegistrationTxnId,
  ProofBundleV2,
  Signer,
  SignerSource,
} from './bundleSigner.js';

export interface CreateBundleParams {
  documentHash: string;
  envelopeId: string;
  signers: Signer[];
  signerSource: SignerSource;
}

// The single path every entry point (REST, archive upload, webhook, MCP) uses
// to anchor a document hash and produce a signed pqva/2 bundle.
//
// Each call anchors one document in its own Algorand txn (a Merkle tree with a
// single leaf, so the root is SHA-256(0x00 || documentHash)). The Merkle
// structure is kept so batching can be added without a format change.
export async function createProofBundle(params: CreateBundleParams): Promise<ProofBundleV2> {
  // Fail before spending an Algorand fee if the signing config is incomplete.
  const keyRegistrationTxnId = getKeyRegistrationTxnId();

  const tree = buildMerkleTree([params.documentHash]);
  const merkleRoot = getMerkleRoot(tree);
  const { txId, confirmedRound, sender, blockTime } = await anchorToAlgorand(merkleRoot, [
    params.envelopeId,
  ]);

  return signBundle({
    protocol: 'pqva/2',
    envelopeId: params.envelopeId,
    documentHash: params.documentHash,
    batchId: txId,
    merkleRoot,
    merkleProof: getMerkleProof(tree, params.documentHash),
    algorandTxnId: txId,
    algorandRound: confirmedRound,
    ...(blockTime ? { blockTimestamp: blockTime } : {}),
    stateProofRound: coveringRound(confirmedRound),
    issuerAddress: sender,
    keyRegistrationTxnId,
    signers: params.signers,
    signerSource: params.signerSource,
    algorithm: 'ml-dsa-65',
  });
}
