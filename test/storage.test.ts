import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Use the filesystem backend in a temp dir (no Blob credentials in tests).
process.env.PQVA_ARCHIVE_DIR = mkdtempSync(path.join(tmpdir(), 'pqva-'));
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;

test('claims are exclusive until released', async () => {
  const { getStorage } = await import('../src/storage.js');
  const s = getStorage();
  assert.equal(s.kind, 'filesystem');
  assert.equal(await s.claim('payments/abc', 'a'), true);
  assert.equal(await s.claim('payments/abc', 'b'), false);
  await s.release('payments/abc');
  assert.equal(await s.claim('payments/abc', 'c'), true);
});

test('concurrent claims on one key admit exactly one', async () => {
  const { getStorage } = await import('../src/storage.js');
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => getStorage().claim('webhooks/env-1', `n${i}`)));
  assert.equal(results.filter(Boolean).length, 1);
});

test('archive records round-trip and keys cannot escape the root', async () => {
  const store = await import('../src/archiveStore.js');
  const { getStorage } = await import('../src/storage.js');
  const id = store.newRecordId('contract');
  await store.saveRecord(
    {
      id,
      envelopeId: id,
      title: 'contract',
      filename: 'contract.pdf',
      documentHash: 'a'.repeat(64),
      signers: [],
      signerSource: 'requester-asserted',
      txId: 'T'.repeat(52),
      round: 1,
      stateProofRound: 256,
      archivedAt: new Date().toISOString(),
    },
    '{"protocol":"pqva/2"}',
    Buffer.from('%PDF'),
  );
  assert.equal((await store.getRecord(id))?.filename, 'contract.pdf');
  assert.equal((await store.readPdf(id))?.toString(), '%PDF');
  assert.ok((await store.listRecords()).some(r => r.id === id));
  assert.equal(await store.getRecord('../../etc/passwd'), undefined);
  await assert.rejects(getStorage().get('../outside'));
});

test('claim states: fresh, then current state is visible to later callers', async () => {
  const { tryClaim, setClaim, readClaim } = await import('../src/claims.js');
  const first = await tryClaim('payments/TXID1', 'settling');
  assert.equal(first.fresh, true);
  const second = await tryClaim('payments/TXID1', 'settling');
  assert.equal(second.fresh, false);
  assert.equal(second.fresh === false && second.current?.state, 'settling');
  await setClaim('payments/TXID1', 'fulfilled');
  assert.equal((await readClaim('payments/TXID1'))?.state, 'fulfilled');
});

test('record ids sort newest first and stay within the id format', async () => {
  const { newRecordId } = await import('../src/archiveStore.js');
  const realNow = Date.now;
  try {
    Date.now = () => 1_800_000_000_000;
    const older = newRecordId('contract');
    Date.now = () => 1_800_000_001_000;
    const newer = newRecordId('contract');
    assert.ok(newer < older, `${newer} should sort before ${older}`);
    const long = newRecordId('ds-' + 'x'.repeat(100));
    assert.match(long, /^[a-z0-9-]{1,80}$/);
  } finally {
    Date.now = realNow;
  }
});

test('signer links resolve, rotate (revoking the old link) and never expose the token', async () => {
  const store = await import('../src/archiveStore.js');
  const id = store.newRecordId('shared');
  const token = store.newShareToken();
  await store.saveRecord(
    {
      id,
      envelopeId: 'env-shared',
      title: 'shared',
      filename: 'shared.pdf',
      documentHash: 'b'.repeat(64),
      signers: [],
      signerSource: 'docusign-connect',
      txId: 'T'.repeat(52),
      round: 1,
      stateProofRound: 256,
      archivedAt: new Date().toISOString(),
      shareToken: token,
    },
    '{"protocol":"pqva/2"}',
    Buffer.from('%PDF'),
  );
  await store.indexShareToken(id, token);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await store.resolveShareToken(token))?.id, id);

  const rotated = await store.rotateShareToken(id);
  assert.ok(rotated && rotated !== token);
  assert.equal(await store.resolveShareToken(token), undefined);
  assert.equal((await store.resolveShareToken(rotated))?.id, id);

  assert.equal(await store.resolveShareToken('not-a-token'), undefined);
  assert.equal(await store.resolveShareToken('../../records/x'), undefined);
  assert.equal(await store.rotateShareToken('sample-contract'), undefined);

  const view = store.sharedView((await store.getRecord(id))!);
  assert.equal('shareToken' in view, false);
  assert.equal('id' in view, false);
});
