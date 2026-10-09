import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBaseFromUserInfo } from '../src/docusignClient.js';

const info = {
  accounts: [
    { account_id: 'aaa', base_uri: 'https://na3.docusign.net' },
    { account_id: 'bbb', base_uri: 'https://eu.docusign.net/' },
  ],
};

test('REST base comes from the matching account base_uri', () => {
  assert.equal(apiBaseFromUserInfo(info, 'aaa'), 'https://na3.docusign.net/restapi');
  assert.equal(apiBaseFromUserInfo(info, 'bbb'), 'https://eu.docusign.net/restapi');
});

test('unknown account or non-DocuSign host is rejected', () => {
  assert.throws(() => apiBaseFromUserInfo(info, 'ccc'), /not found/);
  assert.throws(
    () => apiBaseFromUserInfo({ accounts: [{ account_id: 'x', base_uri: 'https://evil.example/docusign.net' }] }, 'x'),
    /unexpected/,
  );
});
