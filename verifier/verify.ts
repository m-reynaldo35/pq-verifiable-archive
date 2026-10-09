// Standalone verifier. Deliberately does not load .env: what this tool trusts
// must come from its own flags, not from whatever file is in the current
// directory.
import { readFile } from 'fs/promises';
import { Command } from 'commander';
import { verifyBundle } from '../src/verifyBundle.js';
import { describeCapture } from '../src/captureSummary.js';
import { DEFAULT_INDEXER_URL, HOSTED_ISSUERS, TrustAnchor } from '../src/config.js';

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_ERROR = 2;

function errorOut(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_ERROR);
}

async function main() {
  const program = new Command();
  program
    .description(
      'Verify a pqva proof bundle. Exit codes: 0 = valid, 1 = invalid, 2 = could not verify (network/config).\n' +
        'Without --issuer-address the built-in issuers of the hosted pq-verifiable-archive service are trusted.',
    )
    .requiredOption('--bundle <path>', 'path to proof bundle JSON')
    .option('--pdf <path>', 'path to the original document; without it only the bundle is verified')
    .option('--issuer-address <addr>', 'trusted issuer Algorand address')
    .option('--key-reg-txn <txid>', 'trusted issuer key registration txn id (required with --issuer-address)')
    .option('--pk-sha256 <hex>', 'sha256 of the trusted issuer ML-DSA-65 public key: a strict pin (only this key is accepted, no network needed)')
    .option('--public-key-file <path>', 'hex ML-DSA-65 public key, only needed for legacy bundles without an embedded key')
    .option('--indexer <url>', 'Algorand indexer URL', DEFAULT_INDEXER_URL)
    .parse();

  const opts = program.opts<{
    bundle: string;
    pdf?: string;
    issuerAddress?: string;
    keyRegTxn?: string;
    pkSha256?: string;
    publicKeyFile?: string;
    indexer: string;
  }>();

  let trust: TrustAnchor[];
  if (opts.issuerAddress) {
    if (!opts.keyRegTxn) errorOut('--key-reg-txn is required with --issuer-address');
    trust = [{ issuerAddress: opts.issuerAddress, keyRegistrationTxnId: opts.keyRegTxn, pkSha256: opts.pkSha256 }];
  } else {
    trust = HOSTED_ISSUERS.map(a => ({ ...a }));
  }
  if (opts.publicKeyFile) {
    try {
      const publicKeyHex = (await readFile(opts.publicKeyFile, 'utf8')).trim();
      for (const a of trust) a.publicKeyHex = publicKeyHex;
    } catch {
      errorOut(`cannot read public key file: ${opts.publicKeyFile}`);
    }
  }

  let bundle: unknown;
  try {
    bundle = JSON.parse(await readFile(opts.bundle, 'utf8'));
  } catch {
    errorOut(`cannot read bundle file or it is not valid JSON: ${opts.bundle}`);
  }

  let pdfBuffer: Buffer | undefined;
  if (opts.pdf) {
    try {
      pdfBuffer = await readFile(opts.pdf);
    } catch {
      errorOut(`cannot read document file: ${opts.pdf}`);
    }
  }

  console.log(
    `Trusted issuer${trust.length > 1 ? 's' : ''}: ${trust.map(a => a.issuerAddress).join(', ')}` +
      (opts.issuerAddress ? '' : ' (built-in default: hosted service)'),
  );
  const result = await verifyBundle(bundle, pdfBuffer, { trust, indexerUrl: opts.indexer });

  for (const step of result.steps) {
    if (step.informational) console.log(`  ${step.name}: ${step.detail}`);
    else if (step.skipped) console.log(`– ${step.name}: ${step.detail}`);
    else if (step.error) console.error(`! ${step.name}: ${step.detail}`);
    else if (step.passed) console.log(`✓ ${step.name}: ${step.detail}`);
    else console.error(`✗ ${step.name}: ${step.detail}`);
  }

  if (result.signers.length > 0) {
    console.log(
      result.signerSource === 'docusign-connect'
        ? '\nSigners (reported by DocuSign to the issuer):'
        : '\nSigners (asserted by the requester, NOT verified):',
    );
    for (const s of result.signers) console.log(`  ${s.name} <${s.email}> — signed ${s.signedAt}`);
  }

  // Only shown when the issuer's signature checked out: an unsigned or forged
  // capture record says nothing.
  const signatureOk = result.steps.some(s => s.name === 'ML-DSA-65 Signature' && s.passed);
  if (result.capture && signatureOk) {
    console.log('\nDocument capture (signed by the issuer; times reported by DocuSign and the issuer):');
    for (const line of describeCapture(result.capture, result.anchoredAt)) console.log(`  ${line}`);
  }

  if (result.valid) {
    const asOf = result.anchoredAt ? ` as of ${result.anchoredAt} (ledger time)` : '';
    if (result.documentChecked) {
      console.log('\nVALID ✓');
      console.log(`        Document matches the hash anchored by the trusted issuer${asOf}.`);
    } else {
      console.log('\nBUNDLE VALID — document not checked');
      console.log(`        The bundle is authentic and anchored${asOf}, but no document was supplied (--pdf).`);
    }
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
