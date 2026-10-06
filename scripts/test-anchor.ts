import 'dotenv/config';
import { writeFile } from 'fs/promises';
import { hashDocument } from '../src/documentHasher.js';
import { createProofBundle } from '../src/proofBundleAssembler.js';

// Anchor a throwaway document on mainnet and write its bundle locally.
async function main() {
  const envelopeId = `test-${Date.now()}`;
  const documentHash = hashDocument(Buffer.from(`fake pdf content ${envelopeId}`));
  console.log('Document hash:', documentHash);
  console.log('Anchoring to Algorand...');

  const bundle = await createProofBundle({ documentHash, envelopeId, signers: [], signerSource: 'requester-asserted' });

  const outputPath = `bundles/${envelopeId}.json`;
  await writeFile(outputPath, JSON.stringify(bundle, null, 2), 'utf8');

  console.log('\nBundle written to', outputPath);
  console.log('  issuerAddress:', bundle.issuerAddress);
  console.log('  merkleRoot   :', bundle.merkleRoot);
  console.log('  algorandTxnId:', bundle.algorandTxnId);
  console.log('  algorandRound:', bundle.algorandRound);
  console.log('  signature    :', bundle.signature.slice(0, 32) + '... (' + bundle.signature.length / 2 + ' bytes)');
}

main().catch(e => { console.error(e); process.exit(1); });
