import { writeFile } from 'fs/promises';
import { MerkleTree } from 'merkletreejs';
import { hashDocument } from './documentHasher.js';
import { getMerkleRoot, getMerkleProof } from './merkleBatcher.js';
import { signBundle, ProofBundle, SignerMetadata, DocuSignSigner } from './bundleSigner.js';
import { StateProofData } from './stateProofCollector.js';

export interface AssembleParams {
  envelopeId: string;
  pdfBuffer: Buffer;
  txId: string;
  confirmedRound: number;
  merkleTree: MerkleTree;
  stateProof: StateProofData;
  batchId?: string;
  blockTimestamp?: string;
  signers?: SignerMetadata[];
  docusignSigners?: DocuSignSigner[];
}

export function assembleBundle(params: AssembleParams): ProofBundle {
  const documentHash = hashDocument(params.pdfBuffer);
  const merkleRoot = getMerkleRoot(params.merkleTree);
  const merkleProof = getMerkleProof(params.merkleTree, documentHash);

  const unsigned: Omit<ProofBundle, 'signature'> = {
    protocol: 'pqva/1',
    envelopeId: params.envelopeId,
    documentHash,
    batchId: params.batchId ?? params.txId,
    merkleRoot,
    merkleProof,
    algorandTxnId: params.txId,
    algorandRound: params.confirmedRound,
    blockTimestamp: params.blockTimestamp ?? new Date().toISOString(),
    stateProofRound: params.stateProof.stateProofRound,
    signingMetadata: { signers: params.signers ?? [] },
    docusignSigners: params.docusignSigners ?? [],
    docusignKeyRegistrationTxnId: process.env.DOCUSIGN_KEY_REGISTRATION_TXN_ID ?? '',
    algorithm: 'ml-dsa-65',
  };

  return signBundle(unsigned);
}

export async function saveBundleToFile(bundle: ProofBundle, outputPath: string): Promise<void> {
  await writeFile(outputPath, JSON.stringify(bundle, null, 2), 'utf8');
}
