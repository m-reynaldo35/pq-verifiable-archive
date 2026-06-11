import 'dotenv/config';
import { hashDocument } from '../src/documentHasher.js';
import { buildMerkleTree, getMerkleRoot } from '../src/merkleBatcher.js';
import { anchorToAlgorand } from '../src/algorandAnchor.js';
import { assembleBundle, saveBundleToFile } from '../src/proofBundleAssembler.js';
import { StateProofData } from '../src/stateProofCollector.js';

async function main() {
  const envelopeIds = ['env-001', 'env-002', 'env-003'];
  const pdfBuffers = envelopeIds.map((_, i) => Buffer.from(`fake pdf content ${i + 1}`));
  const hashes = pdfBuffers.map(hashDocument);

  console.log('Document hashes:');
  hashes.forEach((h, i) => console.log(`  ${envelopeIds[i]}: ${h}`));

  const tree = buildMerkleTree(hashes);
  const merkleRoot = getMerkleRoot(tree);
  console.log('\nMerkle root:', merkleRoot);

  console.log('\nAnchoring to Algorand...');
  const { txId, confirmedRound } = await anchorToAlgorand(merkleRoot, envelopeIds);
  console.log('  txId:', txId);
  console.log('  confirmedRound:', confirmedRound);

  // State proof is not yet generated at anchor time; record the covering round.
  const placeholderStateProof: StateProofData = {
    stateProofRound: Math.ceil(confirmedRound / 256) * 256,
    raw: null,
  };

  const bundle = assembleBundle({
    envelopeId: envelopeIds[0],
    pdfBuffer: pdfBuffers[0],
    txId,
    confirmedRound,
    merkleTree: tree,
    stateProof: placeholderStateProof,
  });

  const outputPath = 'bundles/test-bundle.json';
  await saveBundleToFile(bundle, outputPath);

  console.log('\nBundle written to', outputPath);
  console.log('Summary:');
  console.log('  envelopeId   :', bundle.envelopeId);
  console.log('  documentHash :', bundle.documentHash);
  console.log('  merkleRoot   :', bundle.merkleRoot);
  console.log('  merkleProof  :', bundle.merkleProof.length, 'siblings');
  console.log('  algorandTxnId:', bundle.algorandTxnId);
  console.log('  algorandRound:', bundle.algorandRound);
  console.log('  signature    :', bundle.signature.slice(0, 32) + '... (' + bundle.signature.length / 2 + ' bytes)');
}

main().catch(e => { console.error(e); process.exit(1); });
