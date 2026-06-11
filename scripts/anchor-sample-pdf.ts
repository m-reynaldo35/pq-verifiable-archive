import 'dotenv/config';
import { readFile } from 'fs/promises';
import { hashDocument } from '../src/documentHasher.js';
import { buildMerkleTree, getMerkleRoot } from '../src/merkleBatcher.js';
import { anchorToAlgorand } from '../src/algorandAnchor.js';
import { assembleBundle, saveBundleToFile } from '../src/proofBundleAssembler.js';
import { StateProofData } from '../src/stateProofCollector.js';

async function main() {
  const pdf = await readFile('assets/sample-contract.pdf');
  const hash = hashDocument(pdf);
  console.log('PDF hash:', hash);

  const tree = buildMerkleTree([hash]);
  const merkleRoot = getMerkleRoot(tree);
  console.log('Anchoring to Algorand...');

  const { txId, confirmedRound, blockTime } = await anchorToAlgorand(merkleRoot, ['sample-contract']);
  console.log('txId:', txId);
  console.log('confirmedRound:', confirmedRound);
  console.log('blockTime:', blockTime);

  const stateProof: StateProofData = {
    stateProofRound: Math.ceil(confirmedRound / 256) * 256,
    raw: null,
  };

  const bundle = assembleBundle({
    envelopeId: 'sample-contract',
    pdfBuffer: pdf,
    txId,
    confirmedRound,
    merkleTree: tree,
    stateProof,
    anchorTime: blockTime,
  });

  await saveBundleToFile(bundle, 'bundles/sample-contract-bundle.json');
  console.log('Bundle written to bundles/sample-contract-bundle.json');
}

main().catch(e => { console.error(e); process.exit(1); });
