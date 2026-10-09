import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCapture, formatGap } from '../src/captureSummary.js';

const capture = {
  source: 'docusign-envelope-combined' as const,
  envelopeCompletedAt: '2026-10-09T08:52:41.727Z',
  capturedAt: '2026-10-09T08:53:05.556Z',
};

test('capture summary shows completion, archive gap and ledger time', () => {
  const lines = describeCapture(capture, '2026-10-09T08:53:06.000Z');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /completed: 2026-10-09T08:52:41\.727Z$/);
  assert.match(lines[1], /2026-10-09T08:53:05\.556Z \(\+24 s after completion\)$/);
  assert.match(lines[2], /ledger time\): +2026-10-09T08:53:06\.000Z$/);
});

test('capture summary omits the ledger line when the anchor time is unknown', () => {
  assert.equal(describeCapture(capture).length, 2);
});

test('gap formatting covers long gaps, negative gaps and bad input', () => {
  assert.equal(formatGap('2026-10-09T08:00:00Z', '2026-10-09T08:30:00Z'), '+30 min after completion');
  assert.equal(formatGap('2026-10-09T08:00:00Z', '2026-10-09T13:00:00Z'), '+5 h after completion');
  assert.equal(formatGap('2026-10-09T08:00:10Z', '2026-10-09T08:00:00Z'), '10 s BEFORE completion');
  assert.equal(formatGap('nope', '2026-10-09T08:00:00Z'), 'gap unknown');
});
