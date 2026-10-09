import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Filesystem storage in a temp dir (no Blob credentials in tests).
process.env.PQVA_ARCHIVE_DIR = mkdtempSync(path.join(tmpdir(), 'pqva-demo-'));
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;

test('daily quota admits exactly the limit, even under concurrency', async () => {
  process.env.PQVA_DEMO_ENVELOPES_PER_DAY = '3';
  const { takeDailySlot } = await import('../src/demo.js');
  const day = new Date('2026-10-09T12:00:00Z');
  const results = await Promise.all(Array.from({ length: 10 }, () => takeDailySlot('envelope', day)));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(await takeDailySlot('envelope', day), false);
  // A new UTC day and a different kind have their own quota.
  assert.equal(await takeDailySlot('envelope', new Date('2026-10-10T00:00:01Z')), true);
  assert.equal(await takeDailySlot('anchor', day), true);
});

test('a zero limit turns a demo path off', async () => {
  process.env.PQVA_DEMO_ANCHORS_PER_DAY = '0';
  const { takeDailySlot } = await import('../src/demo.js');
  assert.equal(await takeDailySlot('anchor', new Date('2026-11-01T00:00:00Z')), false);
  delete process.env.PQVA_DEMO_ANCHORS_PER_DAY;
});

test('demo names are restricted and normalised', async () => {
  const { validateDemoName } = await import('../src/demo.js');
  assert.equal(validateDemoName('  Ada   Lovelace '), 'Ada Lovelace');
  assert.equal(validateDemoName("Seán O'Brien-Ní"), "Seán O'Brien-Ní");
  assert.equal(validateDemoName('<script>'), undefined);
  assert.equal(validateDemoName('a'.repeat(61)), undefined);
  assert.equal(validateDemoName(''), undefined);
  assert.equal(validateDemoName(42), undefined);
});

test('the demo contract escapes the name and carries the signing anchor', async () => {
  const { demoContractHtml, DEMO_SIGN_ANCHOR } = await import('../src/demo.js');
  const html = demoContractHtml('A & B', new Date('2026-10-09T00:00:00Z'));
  assert.ok(html.includes('A &amp; B'));
  assert.ok(!html.includes('A & B'));
  assert.ok(html.includes(DEMO_SIGN_ANCHOR));
  assert.ok(html.includes('2026-10-09'));
});

test('placeholder emails use a reserved domain', async () => {
  const { placeholderEmail } = await import('../src/demo.js');
  assert.match(placeholderEmail(), /^demo-signer-[0-9a-f]{12}@example\.com$/);
});

test('demo status: waiting until the webhook archives the envelope, then the signer link', async () => {
  const demo = await import('../src/demo.js');
  const store = await import('../src/archiveStore.js');
  const token = demo.newDemoToken();
  const envelopeId = 'ABCDEF12-3456-7890-abcd-ef1234567890';
  await demo.saveDemoSession(token, {
    envelopeId,
    clientUserId: 'c1',
    signerName: 'Ada',
    signerEmail: 'demo-signer-000000000000@example.com',
    createdAt: new Date().toISOString(),
  });
  const session = await demo.loadDemoSession(token);
  assert.ok(session);
  assert.deepEqual(await demo.demoStatus(session), { state: 'waiting' });

  // What the webhook does once the envelope is completed.
  const canonicalId = store.webhookCanonicalId(envelopeId);
  const shareToken = store.newShareToken();
  const record = {
    id: store.newRecordId(`ds-${canonicalId}`),
    envelopeId,
    title: `docusign-${envelopeId}`,
    filename: `${envelopeId}.pdf`,
    documentHash: 'a'.repeat(64),
    signers: [],
    signerSource: 'docusign-connect' as const,
    txId: 'T'.repeat(52),
    round: 1,
    stateProofRound: 0,
    archivedAt: new Date().toISOString(),
    shareToken,
  };
  await store.saveRecord(record, '{}', Buffer.from('%PDF'));
  await store.indexEnvelope(canonicalId, record.id);
  assert.deepEqual(await demo.demoStatus(session), { state: 'done', path: `/d/${shareToken}` });
});

test('malformed or unknown session tokens resolve to nothing', async () => {
  const demo = await import('../src/demo.js');
  assert.equal(await demo.loadDemoSession('../../etc/passwd'), undefined);
  assert.equal(await demo.loadDemoSession(demo.newDemoToken()), undefined);
  const store = await import('../src/archiveStore.js');
  assert.equal(await store.recordIdForEnvelope('../x'), undefined);
});
