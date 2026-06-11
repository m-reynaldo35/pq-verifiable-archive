import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

export function hashDocument(pdfBuffer: Buffer): string {
  return createHash('sha256').update(pdfBuffer).digest('hex');
}

export async function hashDocumentFromPath(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return hashDocument(buffer);
}
