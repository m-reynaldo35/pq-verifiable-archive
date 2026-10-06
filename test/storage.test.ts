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
  assert.equal(await s.claim('payments/abc'), true);
  assert.equal(await s.claim('payments/abc'), false);
  await s.release('payments/abc');
  assert.equal(await s.claim('payments/abc'), true);
});

test('concurrent claims on one key admit exactly one', async () => {
  const { getStorage } = await import('../src/storage.js');
  const results = await Promise.all(Array.from({ length: 10 }, () => getStorage().claim('webhooks/env-1')));
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
