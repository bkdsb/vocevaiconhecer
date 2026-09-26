import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, publicConfig } from '../src/config.js';

test('config keeps secrets out of public status', () => { const config = loadConfig({ META_APP_SECRET: 'private', META_APP_ID: '1051796081025755', META_REDIRECT_URI: 'https://example.test/cb', VVC_ALLOWED_SENDERS: '+5511999999999' }, '/tmp'); const status = publicConfig(config); assert.equal(status.metaConfigured, true); assert.equal('metaAppSecret' in status, false); assert.deepEqual(config.allowedSenders, ['+5511999999999']); });

const APP_ID = '1051796081025755';
const FILE_TOKEN = 'private-test-file-token';
const record = (changes = {}) => ({ appId: APP_ID, pageId: '123456', pageToken: FILE_TOKEN, pageName: 'Você Vai Conhecer', validatedAt: '2026-09-25T12:00:00.000Z', ...changes });

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'vvc-config-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const directory = join(cwd, 'data/meta'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'page.json');
  const save = (value = record(), mode = 0o600) => { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode }); chmodSync(path, mode); };
  return { cwd, path, directory, save, env: { META_APP_ID: APP_ID } };
}

function sanitizedFailure(run, code = 'META_CREDENTIALS_INVALID') {
  assert.throws(run, (error) => { assert.equal(error.code, code); assert.ok(!error.message.includes(FILE_TOKEN)); assert.ok(!error.message.includes('secret-env-token')); assert.equal('cause' in error, false); return true; });
}

test('private OAuth credential file is loaded without exposing credentials or enabling publication', (t) => {
  const f = fixture(t); f.save();
  const config = loadConfig(f.env, f.cwd); assert.equal(config.metaPageId, '123456'); assert.equal(config.metaPageToken, FILE_TOKEN); assert.equal(config.metaPublishEnabled, false);
  const status = publicConfig(config); assert.equal(status.metaPageConfigured, true); assert.equal('metaCredentialsFile' in status, false);
  assert.ok(!JSON.stringify(status).includes(FILE_TOKEN)); assert.ok(!JSON.stringify(status).includes('123456'));
});

test('missing default credential file is allowed; explicit missing override fails closed', (t) => {
  const f = fixture(t); const config = loadConfig({ ...f.env, META_PAGE_ID: '', META_PAGE_TOKEN: '', META_CREDENTIALS_FILE: '' }, f.cwd);
  assert.equal(config.metaPageId, ''); assert.equal(config.metaPageToken, '');
  sanitizedFailure(() => loadConfig({ ...f.env, META_CREDENTIALS_FILE: './does-not-exist.json' }, f.cwd));
});

test('complete environment pair takes priority without reading invalid or missing files', (t) => {
  const f = fixture(t); f.save('not JSON');
  const config = loadConfig({ ...f.env, META_PAGE_ID: '999999', META_PAGE_TOKEN: 'secret-env-token', META_CREDENTIALS_FILE: './missing-file.json' }, f.cwd);
  assert.equal(config.metaPageId, '999999'); assert.equal(config.metaPageToken, 'secret-env-token');
  assert.ok(!JSON.stringify(publicConfig(config)).includes('secret-env-token'));
});

test('partial environment pairs cannot mix with file credentials', (t) => {
  const f = fixture(t); f.save();
  sanitizedFailure(() => loadConfig({ ...f.env, META_PAGE_ID: '999999' }, f.cwd), 'META_CREDENTIALS_INCOMPLETE');
  sanitizedFailure(() => loadConfig({ ...f.env, META_PAGE_TOKEN: 'secret-env-token' }, f.cwd), 'META_CREDENTIALS_INCOMPLETE');
  sanitizedFailure(() => loadConfig({ ...f.env, META_PAGE_ID: 'not-an-id', META_PAGE_TOKEN: 'secret-env-token' }, f.cwd));
});

test('mismatched app and malformed or incomplete records fail with sanitized errors', (t) => {
  const f = fixture(t);
  for (const value of [record({ appId: '999999' }), record({ pageId: 'bad' }), record({ pageToken: `${FILE_TOKEN}\n` }), record({ validatedAt: 'not a date' }), record({ pageName: '' }), { pageToken: FILE_TOKEN }, `{ malformed ${FILE_TOKEN}`, []]) {
    f.save(value); sanitizedFailure(() => loadConfig(f.env, f.cwd));
  }
});

test('credential files require private permissions, regular files, no symlinks and bounded size', (t) => {
  const f = fixture(t); f.save(record(), 0o644); sanitizedFailure(() => loadConfig(f.env, f.cwd));
  f.save(record()); const symbolic = join(f.cwd, 'linked.json'); symlinkSync(f.path, symbolic);
  sanitizedFailure(() => loadConfig({ ...f.env, META_CREDENTIALS_FILE: symbolic }, f.cwd));
  sanitizedFailure(() => loadConfig({ ...f.env, META_CREDENTIALS_FILE: f.directory }, f.cwd));
  f.save('x'.repeat(64 * 1024 + 1)); sanitizedFailure(() => loadConfig(f.env, f.cwd));
});

test('explicit private credential path and custom data directory resolve relative to cwd', (t) => {
  const f = fixture(t); f.save();
  const explicit = loadConfig({ ...f.env, META_CREDENTIALS_FILE: 'data/meta/page.json' }, f.cwd); assert.equal(explicit.metaPageToken, FILE_TOKEN);
  const dataDir = join(f.cwd, 'other'); mkdirSync(join(dataDir, 'meta'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'meta/page.json'), JSON.stringify(record({ pageId: '777777' })), { mode: 0o600 });
  assert.equal(loadConfig({ ...f.env, VVC_DATA_DIR: './other' }, f.cwd).metaPageId, '777777');
});
