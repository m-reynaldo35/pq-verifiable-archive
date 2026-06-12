import { config } from 'dotenv';
import { readFile, writeFile } from 'fs/promises';
import path from 'node:path';
import { signBundle, ProofBundle } from '../src/bundleSigner.js';

// One-off: re-sign the demo sample bundle after adding DocuSign signers so the
// bundle stays VALID (the signer list is part of the signed payload). Also
// embeds the ML-DSA public key via signBundle(). Reads keys from an explicit
// .env path so it can run from a git worktree.
async function main(): Promise<void> {
  const envPath = process.env.RESIGN_ENV_PATH;
  if (envPath) config({ path: envPath });
  else config();

  const bundlePath = path.resolve('bundles/sample-contract-bundle.json');
  const raw = await readFile(bundlePath, 'utf8');
  const existing = JSON.parse(raw) as ProofBundle;

  const docusignSigners = [
    { name: 'Alex Mercer', email: 'alex.mercer@nexusventures.example', signedAt: '2026-06-11T14:18:42.000Z' },
    { name: 'Dana Brightfield', email: 'dana@brightfieldanalytics.example', signedAt: '2026-06-11T14:19:55.000Z' },
  ];

  const { signature: _omit, mldsaPublicKey: _omit2, ...rest } = existing;
  const unsigned: Omit<ProofBundle, 'signature'> = {
    ...rest,
    docusignSigners,
  };

  const signed = signBundle(unsigned);
  await writeFile(bundlePath, JSON.stringify(signed, null, 2) + '\n', 'utf8');
  console.log(`Re-signed ${bundlePath} with ${docusignSigners.length} signers + embedded public key.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
