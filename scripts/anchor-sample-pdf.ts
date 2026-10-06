import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';
import { hashDocument } from '../src/documentHasher.js';
import { createProofBundle } from '../src/proofBundleAssembler.js';

// Re-anchor the demo sample PDF and write a fresh pqva/2 bundle for /demo.
async function main() {
  const pdf = await readFile('assets/sample-contract.pdf');
  const documentHash = hashDocument(pdf);
  console.log('PDF hash:', documentHash);
  console.log('Anchoring to Algorand...');

  const bundle = await createProofBundle({
    documentHash,
    envelopeId: 'sample-contract',
    signers: [],
    signerSource: 'requester-asserted',
  });

  console.log('txId:', bundle.algorandTxnId);
  console.log('round:', bundle.algorandRound);
  await writeFile('bundles/sample-contract-bundle.json', JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  console.log('Bundle written to bundles/sample-contract-bundle.json');
}

main().catch(e => { console.error(e); process.exit(1); });
