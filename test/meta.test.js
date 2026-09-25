import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaProvider } from '../src/providers/meta.js';

const cfg = { metaAppId: '1051796081025755', metaAppSecret: 'secret-for-test', metaRedirectUri: 'https://example.test/callback', metaApiVersion: 'v26.0' };
function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('Meta OAuth URL validates state and includes app/version', () => { const url = new URL(createMetaProvider(cfg).authorizationUrl('x'.repeat(24))); assert.equal(url.searchParams.get('client_id'), cfg.metaAppId); assert.equal(url.pathname, '/v26.0/dialog/oauth'); assert.throws(() => createMetaProvider(cfg).authorizationUrl('bad'), /state/); });
test('Meta listPages follows safe cursor and returns pages', async () => { let calls = 0; const meta = createMetaProvider(cfg, { fetchImpl: async (url) => { calls += 1; if (calls === 1) return response({ data: [{ id: '123', name: 'Página', access_token: 'page-token', tasks: ['CREATE_CONTENT'] }], paging: { next: 'https://graph.facebook.com/v26.0/me/accounts?after=next', cursors: { after: 'next' } } }); return response({ data: [{ id: '456', name: 'Outra', access_token: 'other-token', tasks: [] }] }); } }); assert.deepEqual((await meta.listPages('user-token')).map((p) => p.id), ['123', '456']); });
test('Meta publication rejects an explicit Graph error and never retries', async () => { let calls = 0; const meta = createMetaProvider(cfg, { fetchImpl: async () => { calls += 1; return response({ error: { code: 200, error_subcode: 10, message: 'secret should not leak' } }, 403); } }); await assert.rejects(() => meta.publishPhoto({ pageId: '123', pageToken: 'page-token', imagePath: new URL('../assets/brand/logo.png', import.meta.url).pathname, caption: 'Legenda' }), (error) => error.code === 'META_REJECTED' && !error.message.includes('secret')); assert.equal(calls, 1); });

test('Meta rejects an invalid buffer instead of silently reopening the path', async () => {
  const meta = createMetaProvider(cfg, { fetchImpl: async () => assert.fail('invalid bytes must not be uploaded') });
  const imagePath = new URL('../assets/brand/logo.png', import.meta.url).pathname;
  for (const imageBuffer of [null, Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1), Buffer.from('not a png')]) {
    await assert.rejects(meta.publishPhoto({ pageId: '123', pageToken: 'page-token', imagePath, imageBuffer, caption: 'Legenda' }), { code: 'META_INVALID_INPUT' });
  }
});

test('Meta snapshots supplied image bytes before asynchronous upload', async () => {
  const imageBuffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 12, 34]);
  const expected = Buffer.from(imageBuffer);
  const meta = createMetaProvider(cfg, { fetchImpl: async (_url, request) => {
    imageBuffer.fill(0);
    assert.deepEqual(Buffer.from(await request.body.get('source').arrayBuffer()), expected);
    return response({ id: '12345' });
  } });
  await meta.publishPhoto({ pageId: '123', pageToken: 'page-token', imageBuffer, caption: 'Legenda' });
});

test('interrupted or inconclusive Meta writes are unknown and never retried', async () => {
  const imageBuffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const answer of [() => { throw new Error('network interrupted'); }, () => response({}, 503), () => new Response('malformed'), () => response({})]) {
    let calls = 0;
    const meta = createMetaProvider(cfg, { fetchImpl: async () => { calls += 1; return answer(); } });
    await assert.rejects(meta.publishPhoto({ pageId: '123', pageToken: 'page-token', imageBuffer, caption: 'Legenda' }), { code: 'PUBLICATION_UNKNOWN' });
    assert.equal(calls, 1);
  }
});
