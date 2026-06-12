import 'dotenv/config';
import { readFile } from 'fs/promises';
import { Command } from 'commander';
import { ProofBundle } from '../src/bundleSigner.js';
import { verifyBundle } from '../src/verifyBundle.js';

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_ERROR = 2;

function errorOut(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_ERROR);
}

async function loadBundle(path: string): Promise<ProofBundle> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    errorOut(`cannot read bundle file: ${path}`);
  }
  try {
    return JSON.parse(text) as ProofBundle;
  } catch {
    errorOut(`bundle is not valid JSON: ${path}`);
  }
}

async function main() {
  const program = new Command();
  program
    .requiredOption('--bundle <path>', 'path to proof bundle JSON')
    .option('--pdf <path>', 'path to original PDF for hash verification')
    .parse();

  const opts = program.opts<{ bundle: string; pdf?: string }>();
  const bundle = await loadBundle(opts.bundle);

  let pdfBuffer: Buffer | undefined;
  if (opts.pdf) {
    try {
      pdfBuffer = await readFile(opts.pdf);
    } catch {
      errorOut(`cannot read PDF file: ${opts.pdf}`);
    }
  }

  const result = await verifyBundle(bundle, pdfBuffer);

  for (const step of result.steps) {
    if (step.informational) {
      console.log(`  ${step.name.toLowerCase()}: ${step.detail}`);
    } else if (step.skipped) {
      console.log(`– ${step.name}: ${step.detail}`);
    } else if (step.error) {
      console.error(`! ${step.name}: ${step.detail}`);
    } else if (step.passed) {
      console.log(`✓ ${step.name}: ${step.detail}`);
    } else {
      console.error(`✗ ${step.name}: ${step.detail}`);
    }
  }

  if (result.signers.length > 0) {
    console.log('\nSigners:');
    for (const s of result.signers) {
      console.log(`  ${s.name} <${s.email}> — signed ${s.signedAt}`);
    }
  }

  if (result.valid) {
    console.log('\nVALID ✓');
    const asOf = bundle.blockTimestamp ? ` as of ${bundle.blockTimestamp}` : '';
    console.log(`        Document integrity proven${asOf}.`);
    console.log('        AlgoNode confirms on-chain record. DocuSign attestation verified offline.');
    process.exit(EXIT_VALID);
  }

  if (result.operationalError) {
    console.error('\nCOULD NOT VERIFY — network or configuration error');
    process.exit(EXIT_ERROR);
  }

  console.error('\nINVALID ✗');
  process.exit(EXIT_INVALID);
}

main().catch(e => {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(EXIT_ERROR);
});
