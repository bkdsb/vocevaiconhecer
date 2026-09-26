import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createMetaAuth } from '../src/meta-auth.js';
import { runMetaAuthCli } from '../scripts/meta-auth.mjs';

const APP = '1051796081025755'; const PAGE = '123456';
const SECRET = 'test-app-secret-only'; const PAGE_TOKEN = 'test-page-token-only';
const clock = '2026-09-25T12:00:00.000Z';
const permissions = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const pages = () => [{ id: PAGE, name: 'Você Vai Conhecer', accessToken: PAGE_TOKEN, tasks: ['CREATE_CONTENT'] }, { id: '234567', name: 'Outra Página', accessToken: 'second-private-page-token', tasks: ['ANALYZE'] }];

async function fixture(t, changes = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'vvc-meta-auth-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, metaAppId: APP, metaAppSecret: SECRET, metaRedirectUri: 'https://vvc.example/auth/meta/callback', metaPublishEnabled: false, ...changes.config };
  const calls = []; let current = new Date(clock);
  const meta = {
    authorizationUrl(state) { const url = new URL('https://www.facebook.com/v26.0/dialog/oauth'); url.searchParams.set('state', state); url.searchParams.set('redirect_uri', config.metaRedirectUri); return url.href; },
    async exchangeCode(code) { calls.push(['exchange', code]); return { accessToken: 'short-private-token', expiresIn: 3600 }; },
    async extendToken(value) { calls.push(['extend', value]); return { accessToken: 'long-private-token', expiresIn: 60 * 86400 }; },
    async listPages(value) { calls.push(['pages', value]); return pages(); },
    async inspectToken(value) { calls.push(['inspect', value]); return { is_valid: true, app_id: APP, type: 'PAGE', profile_id: PAGE, scopes: permissions, expires_at: 0, data_access_expires_at: 0, granular_scopes: permissions.map((scope) => ({ scope, target_ids: [PAGE] })) }; },
    async verifyPage(value) { calls.push(['verify', value]); return { id: PAGE, name: 'Você Vai Conhecer' }; },
    ...changes.meta,
  };
  const auth = createMetaAuth(config, { meta, now: () => current });
  const callback = (authorizationUrl, updates = {}) => {
    const url = new URL(config.metaRedirectUri); url.searchParams.set('state', new URL(authorizationUrl).searchParams.get('state')); url.searchParams.set('code', 'private-code-from-browser');
    for (const [key, value] of Object.entries(updates)) value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value);
    return url.href;
  };
  return { config, calls, auth, meta, callback, setNow: (value) => { current = new Date(value); } };
}
function noSecrets(value) { const text = JSON.stringify(value); for (const secret of [SECRET, PAGE_TOKEN, 'second-private-page-token', 'short-private-token', 'long-private-token', 'private-code-from-browser']) assert.ok(!text.includes(secret), 'public output leaked a credential'); }

test('start persists unique private state with ten-minute lifetime and no app secret', async (t) => {
  const f = await fixture(t); const first = await f.auth.start(); const second = await f.auth.start();
  assert.notEqual(first.authorizationUrl, second.authorizationUrl);
  assert.equal(first.expiresAt, '2026-09-25T12:10:00.000Z'); noSecrets(first);
  const dir = join(f.config.dataDir, 'meta');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const files = await readdir(dir); assert.equal(files.length, 2);
  for (const file of files) { assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600); noSecrets(await readFile(join(dir, file), 'utf8')); }
});

test('finish consumes state once and keeps all tokens in private pending storage', async (t) => {
  const f = await fixture(t); const started = await f.auth.start(); const callback = f.callback(started.authorizationUrl);
  const result = await f.auth.finish(callback);
  assert.equal(result.selectionRequired, true); assert.equal(result.pages[0].id, PAGE); noSecrets(result);
  assert.deepEqual(f.calls.map(([name]) => name), ['exchange', 'extend', 'pages']);
  await assert.rejects(f.auth.finish(callback), { code: 'META_AUTH_STATE' });
  const path = join(f.config.dataDir, 'meta', 'pending.json'); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const pending = JSON.parse(await readFile(path, 'utf8')); assert.equal(pending.pages[0].accessToken, PAGE_TOKEN);
  const listed = await f.auth.list(); noSecrets(listed); assert.equal(listed.pages.length, 2);
});

test('concurrent callbacks exchange the same state at most once', async (t) => {
  const f = await fixture(t); const started = await f.auth.start(); const callback = f.callback(started.authorizationUrl);
  const results = await Promise.allSettled([f.auth.finish(callback), f.auth.finish(callback)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'exchange').length, 1);
});

test('expired, mismatched, duplicated and wrong-redirect state cannot exchange tokens', async (t) => {
  const f = await fixture(t); const started = await f.auth.start(); const valid = f.callback(started.authorizationUrl);
  await assert.rejects(f.auth.finish(valid.replace('vvc.example', 'attacker.example')), { code: 'META_AUTH_CALLBACK' });
  await assert.rejects(f.auth.finish(`${valid}&state=another-state`), { code: 'META_AUTH_CALLBACK' });
  await assert.rejects(f.auth.finish(f.callback(started.authorizationUrl, { state: 'X'.repeat(43) })), { code: 'META_AUTH_STATE' });
  assert.equal(f.calls.length, 0);
  f.setNow('2026-09-25T12:10:00Z');
  await assert.rejects(f.auth.finish(valid), { code: 'META_AUTH_EXPIRED' }); assert.equal(f.calls.length, 0);
});

test('Meta cancellation consumes state and sanitized remote failure does not permit retry', async (t) => {
  const f = await fixture(t); const started = await f.auth.start();
  await assert.rejects(f.auth.finish(f.callback(started.authorizationUrl, { code: null, error: 'access_denied', error_description: SECRET })), { code: 'META_AUTH_DENIED' });
  await assert.rejects(f.auth.finish(f.callback(started.authorizationUrl)), { code: 'META_AUTH_STATE' });
  const broken = await fixture(t, { meta: { async exchangeCode() { throw new Error(`${SECRET} ${PAGE_TOKEN}`); } } }); const retry = await broken.auth.start();
  await assert.rejects(broken.auth.finish(broken.callback(retry.authorizationUrl)), (error) => { noSecrets({ message: error.message, code: error.code }); return error.code === 'META_AUTH_REMOTE'; });
  await assert.rejects(broken.auth.finish(broken.callback(retry.authorizationUrl)), { code: 'META_AUTH_STATE' });
});

test('select validates capability, Page token, targets and identity before writing atomic private credentials', async (t) => {
  const f = await fixture(t); const started = await f.auth.start(); await f.auth.finish(f.callback(started.authorizationUrl));
  await assert.rejects(f.auth.select('999999'), { code: 'META_AUTH_PAGE' });
  await assert.rejects(f.auth.select('234567'), { code: 'META_AUTH_TASKS' });
  assert.equal(f.calls.some(([name]) => name === 'inspect'), false);
  const result = await f.auth.select(PAGE); noSecrets(result); assert.equal(result.connected, true);
  const file = join(f.config.dataDir, 'meta', 'page.json'); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { appId: APP, pageId: PAGE, pageToken: PAGE_TOKEN, pageName: 'Você Vai Conhecer', validatedAt: clock });
  assert.ok(!(await readdir(join(f.config.dataDir, 'meta'))).some((name) => name.includes('.tmp-')));
});

test('selection accepts documented PROFILE_PLUS page task equivalents', async (t) => {
  const f = await fixture(t, { meta: { async listPages() { return [{ ...pages()[0], tasks: ['PROFILE_PLUS_CREATE_CONTENT'] }]; } } });
  const started = await f.auth.start(); await f.auth.finish(f.callback(started.authorizationUrl));
  assert.equal((await f.auth.select(PAGE)).connected, true);
});

test('wrong app, missing scopes, expired tokens and wrong granular targets cannot be saved', async (t) => {
  for (const change of [
    { app_id: '999999' }, { type: 'USER' }, { scopes: ['pages_show_list'] }, { profile_id: '999999' }, { expires_at: 1 }, { granular_scopes: [{ scope: 'pages_manage_posts', target_ids: ['999999'] }] },
  ]) {
    const inspected = { is_valid: true, app_id: APP, type: 'PAGE', scopes: permissions, ...change };
    const f = await fixture(t, { meta: { async inspectToken() { return inspected; } } }); const started = await f.auth.start(); await f.auth.finish(f.callback(started.authorizationUrl));
    await assert.rejects(f.auth.select(PAGE), { code: 'META_AUTH_TOKEN' });
    await assert.rejects(stat(join(f.config.dataDir, 'meta', 'page.json')), { code: 'ENOENT' });
  }
});

test('expired pending selection and mismatched verifyPage result are blocked', async (t) => {
  const f = await fixture(t, { meta: { async verifyPage() { return { id: '999999', name: 'Wrong page' }; } } }); const started = await f.auth.start(); await f.auth.finish(f.callback(started.authorizationUrl));
  await assert.rejects(f.auth.select(PAGE), { code: 'META_AUTH_TOKEN' });
  f.setNow('2026-09-25T12:10:00Z'); await assert.rejects(f.auth.select(PAGE), { code: 'META_AUTH_PENDING' });
});

test('status is read-only and returns booleans without secrets', async (t) => {
  const f = await fixture(t); const initial = await f.auth.status(); assert.equal(initial.storageAvailable, false);
  await assert.rejects(stat(join(f.config.dataDir, 'meta')), { code: 'ENOENT' });
  const started = await f.auth.start(); assert.equal((await f.auth.status()).authorizationPending, true);
  await f.auth.finish(f.callback(started.authorizationUrl)); await f.auth.select(PAGE);
  const status = await f.auth.status(); assert.equal(status.pageConfigured, true); assert.equal(status.publishingEnabled, false); noSecrets(status);
  assert.ok(Object.values(status).every((value) => typeof value === 'boolean'));
});

test('credential files cannot be read through symlinks', async (t) => {
  const f = await fixture(t); await f.auth.start();
  const target = join(f.config.dataDir, 'outside.json'); await writeFile(target, JSON.stringify({ pages: pages() }), { mode: 0o600 });
  await symlink(target, join(f.config.dataDir, 'meta', 'pending.json'));
  await assert.rejects(f.auth.list(), { code: 'META_AUTH_STORAGE' });
});

test('CLI finish reads callback only from stdin and never prints tokens or provider errors', async (t) => {
  const f = await fixture(t); const started = await f.auth.start(); const url = f.callback(started.authorizationUrl);
  let output = ''; const stdout = { write: (value) => { output += value; } };
  assert.equal(await runMetaAuthCli({ args: ['finish', url], config: f.config, auth: f.auth, stdin: Readable.from([]), stdout }), 1); noSecrets(output); assert.match(output, /META_AUTH_INPUT/);
  output = '';
  assert.equal(await runMetaAuthCli({ args: ['finish'], config: f.config, auth: f.auth, stdin: Readable.from([url, '\n']), stdout }), 0); noSecrets(output); assert.equal(JSON.parse(output).selectionRequired, true);
  output = '';
  assert.equal(await runMetaAuthCli({ args: ['status'], config: f.config, auth: { async status() { throw new Error(SECRET); } }, stdout }), 1); noSecrets(output);
});
