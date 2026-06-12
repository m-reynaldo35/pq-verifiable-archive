import { readFile, writeFile } from 'fs/promises';
import path from 'node:path';

// Produces a pre-tampered copy of a demo contract so the presenter has a
// ready-made INVALID moment: the PDF looks identical but its SHA-256 differs,
// so verification fails the "PDF Hash" check.
const SRC = path.resolve('assets/demo-contracts/non-disclosure-agreement.pdf');
const OUT = path.resolve('assets/demo-contracts/non-disclosure-agreement-TAMPERED.pdf');

async function main(): Promise<void> {
  const buf = await readFile(SRC);
  if (buf.length === 0) throw new Error(`source PDF is empty: ${SRC}`);

  // Flip one byte in the middle of the binary content. XOR with 0xff so the
  // change is deterministic and reversible, and never a no-op.
  const tampered = Buffer.from(buf);
  const mid = Math.floor(tampered.length / 2);
  tampered[mid] = tampered[mid] ^ 0xff;

  await writeFile(OUT, tampered);
  console.log(`Tampered PDF written to ${OUT}`);
  console.log(`Flipped byte at offset ${mid} (${buf.length} bytes total).`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
