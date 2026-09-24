import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaProvider } from '../src/providers/meta.js';

const cfg = { metaAppId: '1051796081025755', metaAppSecret: 'secret-for-test', metaRedirectUri: 'https://example.test/callback', metaApiVersion: 'v26.0' };
function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('Meta OAuth URL validates state and includes app/version', () => { const url = new URL(createMetaProvider(cfg).authorizationUrl('x'.repeat(24))); assert.equal(url.searchParams.get('client_id'), cfg.metaAppId); assert.equal(url.pathname, '/v26.0/dialog/oauth'); assert.throws(() => createMetaProvider(cfg).authorizationUrl('bad'), /state/); });
test('Meta listPages follows safe cursor and returns pages', async () => { let calls = 0; const meta = createMetaProvider(cfg, { fetchImpl: async (url) => { calls += 1; if (calls === 1) return response({ data: [{ id: '123', name: 'Página', access_token: 'page-token', tasks: ['CREATE_CONTENT'] }], paging: { next: 'https://graph.facebook.com/v26.0/me/accounts?after=next', cursors: { after: 'next' } } }); return response({ data: [{ id: '456', name: 'Outra', access_token: 'other-token', tasks: [] }] }); } }); assert.deepEqual((await meta.listPages('user-token')).map((p) => p.id), ['123', '456']); });
test('Meta publication rejects an explicit Graph error and never retries', async () => { let calls = 0; const meta = createMetaProvider(cfg, { fetchImpl: async () => { calls += 1; return response({ error: { code: 200, error_subcode: 10, message: 'secret should not leak' } }, 403); } }); await assert.rejects(() => meta.publishPhoto({ pageId: '123', pageToken: 'page-token', imagePath: new URL('../assets/brand/logo.png', import.meta.url).pathname, caption: 'Legenda' }), (error) => error.code === 'META_REJECTED' && !error.message.includes('secret')); assert.equal(calls, 1); });
