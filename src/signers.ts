import type { Signer } from './bundleSigner.js';

export const MAX_SIGNERS = 50;
const MAX_FIELD_LENGTH = 254;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export type SignerValidation = { signers: Signer[] } | { error: string };

// Validate a caller-supplied signer list (REST, multipart form or MCP). Returns
// normalised records containing only the expected fields.
export function validateSigners(input: unknown): SignerValidation {
  if (input === undefined || input === null) return { signers: [] };
  if (!Array.isArray(input)) return { error: 'signers must be an array' };
  if (input.length > MAX_SIGNERS) return { error: `signers array must not exceed ${MAX_SIGNERS} entries` };

  const signers: Signer[] = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i] as Partial<Signer> | null;
    const where = `signer ${i + 1}`;
    if (!s || typeof s !== 'object') return { error: `${where} is not an object` };
    if (typeof s.name !== 'string' || s.name.trim() === '' || s.name.length > MAX_FIELD_LENGTH) {
      return { error: `${where} has an invalid name` };
    }
    if (typeof s.email !== 'string' || s.email.length > MAX_FIELD_LENGTH || !EMAIL_RE.test(s.email)) {
      return { error: `${where} has an invalid email` };
    }
    if (typeof s.signedAt !== 'string' || Number.isNaN(Date.parse(s.signedAt))) {
      return { error: `${where} has an invalid signedAt date` };
    }
    signers.push({
      name: s.name.trim(),
      email: s.email,
      signedAt: new Date(s.signedAt).toISOString(),
    });
  }
  return { signers };
}

const ENVELOPE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function validateEnvelopeId(value: unknown): string | null {
  return typeof value === 'string' && ENVELOPE_ID_RE.test(value) ? value : null;
}
