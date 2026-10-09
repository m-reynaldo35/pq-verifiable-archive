import type { DocumentCapture } from './bundleSigner.js';

// Human-readable lines for a bundle's signed capture record. The times are what
// DocuSign reported and when the issuer archived the copy; both are signed by
// the issuer but neither is independent. The independent time is the ledger
// time of the anchor, shown alongside when known. public/app.js mirrors this.
export function describeCapture(capture: DocumentCapture, anchoredAt?: string): string[] {
  const lines = [
    `DocuSign reported the envelope completed: ${capture.envelopeCompletedAt}`,
    `Issuer archived this copy:               ${capture.capturedAt} (${formatGap(capture.envelopeCompletedAt, capture.capturedAt)})`,
  ];
  if (anchoredAt) lines.push(`Anchored on Algorand (ledger time):      ${anchoredAt}`);
  return lines;
}

// Signed gap between two ISO times, e.g. "+24 s after completion".
export function formatGap(fromIso: string, toIso: string): string {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return 'gap unknown';
  const abs = Math.abs(ms);
  const s = Math.round(abs / 1000);
  const span = s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
  return ms >= 0 ? `+${span} after completion` : `${span} BEFORE completion`;
}
