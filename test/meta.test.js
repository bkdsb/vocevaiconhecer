import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaProvider } from '../src/providers/meta.js';

const cfg = { metaAppId: '1051796081025755', metaAppSecret: 'secret-for-test', metaRedirectUri: 'https://example.test/callback', metaApiVersion: 'v26.0' };
function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('Meta OAuth URL validates state and includes app/version', () => { const url = new URL(createMetaProvider(cfg).authorizationUrl('x'.repeat(24))); assert.equal(url.searchParams.get('client_id'), cfg.metaAppId); assert.equal(url.pathname, '/v26.0/dialog/oauth'); assert.throws(() => createMetaProvider(cfg).authorizationUrl('bad'), /state/); });
test('Meta listPages follows safe cursor and returns pages', async () => { let calls = 0; const meta = createMetaProvider(cfg, { fetchImpl: async (url) => { calls += 1; if (calls === 1) return response({ data: [{ id: '123', name: 'Página', access_token: 'page-token', tasks: ['CREATE_CONTENT'] }], paging: { next: 'https://graph.facebook.com/v26.0/me/accounts?after=next', cursors: { after: 'next' } } }); return response({ data: [{ id: '456', name: 'Outra', access_token: 'other-token', tasks: [] }] }); } }); assert.deepEqual((await meta.listPages('user-token')).map((p) => p.id), ['123', '456']); });
test('Meta reads post performance from reactions, comments, shares and media-view insights', async () => {
  const meta = createMetaProvider(cfg, { fetchImpl: async (url) => {
    const value = String(url);
    if (value.includes('/insights/post_media_view')) return response({ data: [{ values: [{ value: 1200 }] }] });
    if (value.includes('/insights/post_total_media_view_unique')) return response({ data: [{ values: [{ value: 800 }] }] });
    return response({ reactions: { summary: { total_count: 50 } }, comments: { summary: { total_count: 12 } }, shares: { count: 7 } });
  } });
  assert.deepEqual(await meta.getPostPerformance({ postId: '123_456', pageToken: 'page-token' }), { mediaViews: 1200, uniqueViews: 800, reactions: 50, comments: 12, shares: 7, engagementAvailable: true, insightsAvailable: true });
});

test('Meta still records view insights when engagement fields are permission-rejected', async () => {
  const meta = createMetaProvider(cfg, { fetchImpl: async (url) => {
    const value = String(url);
    if (value.includes('/insights/post_media_view')) return response({ data: [{ values: [{ value: 900 }] }] });
    if (value.includes('/insights/post_total_media_view_unique')) return response({ data: [{ values: [{ value: 600 }] }] });
    return response({ error: { code: 10, message: 'permission' } }, 400);
  } });
  assert.deepEqual(await meta.getPostPerformance({ postId: '123_456', pageToken: 'page-token' }), { mediaViews: 900, uniqueViews: 600, reactions: 0, comments: 0, shares: 0, engagementAvailable: false, insightsAvailable: true });
});

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

test('scheduled photo creates a real feed entry with attached media and returns its post ID', async () => {
  const calls = [];
  const meta = createMetaProvider(cfg, { now: () => new Date('2026-10-04T12:00:00Z'), fetchImpl: async (url, request) => {
    calls.push({ path: url.pathname, body: request.body });
    return response(calls.length === 1 ? { id: '12345' } : { id: '123_67890' });
  } });
  const result = await meta.publishPhoto({ pageId: '123', pageToken: 'page-token', imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), caption: 'Approved content', published: false, scheduledPublishTime: '2026-10-04T13:00:00Z' });
  assert.deepEqual(result, { id: '12345', postId: '123_67890' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/v26.0/123/photos');
  assert.equal(calls[0].body.get('published'), 'false');
  assert.equal(calls[0].body.get('scheduled_publish_time'), null);
  assert.equal(calls[1].path, '/v26.0/123/feed');
  assert.deepEqual(JSON.parse(calls[1].body.get('attached_media')), [{ media_fbid: '12345' }]);
  assert.equal(calls[1].body.get('unpublished_content_type'), 'SCHEDULED');
  assert.equal(calls[1].body.get('scheduled_publish_time'), '1791118800');
});

test('invalid schedules fail before any photo upload', async () => {
  const meta = createMetaProvider(cfg, { now: () => new Date('2026-10-04T12:00:00Z'), fetchImpl: async () => assert.fail('invalid date must not write') });
  for (const at of ['', 'invalid', '2026-10-04T12:09:59Z', '2026-11-05T12:00:00Z']) {
    await assert.rejects(meta.publishPhoto({ pageId: '123', pageToken: 'page-token', caption: 'Approved content', scheduledPublishTime: at }), { code: 'META_INVALID_INPUT' });
  }
});

test('a timeout creating scheduled feed is unknown and preserves uploaded photo ID without retrying', async () => {
  let calls = 0;
  const meta = createMetaProvider(cfg, { now: () => new Date('2026-10-04T12:00:00Z'), fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return response({ id: '12345' });
    throw new Error('network-private-details');
  } });
  await assert.rejects(meta.publishPhoto({ pageId: '123', pageToken: 'page-token', imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), caption: 'Approved content', scheduledPublishTime: '2026-10-04T13:00:00Z' }), (error) => error.code === 'PUBLICATION_UNKNOWN' && error.photoId === '12345' && !error.message.includes('private'));
  assert.equal(calls, 2);
});

test('scheduled post reads verify timestamps and follow only validated cursors', async () => {
  let calls = 0;
  const meta = createMetaProvider(cfg, { fetchImpl: async (url) => {
    calls += 1;
    if (calls === 1) return response({ data: [{ id: '123_10', scheduled_publish_time: 1791118800, is_published: false }], paging: { next: 'https://graph.facebook.com/v26.0/123/scheduled_posts?after=next', cursors: { after: 'next' } } });
    assert.equal(url.searchParams.get('after'), 'next');
    return response({ data: [{ id: '123_11', scheduled_publish_time: 1791122400, is_published: false }] });
  } });
  assert.deepEqual(await meta.listScheduledPosts({ pageId: '123', pageToken: 'page-token' }), [
    { id: '123_10', scheduledAt: '2026-10-04T13:00:00.000Z', isPublished: false },
    { id: '123_11', scheduledAt: '2026-10-04T14:00:00.000Z', isPublished: false },
  ]);
  const unsafe = createMetaProvider(cfg, { fetchImpl: async () => response({ data: [], paging: { next: 'https://untrusted.test/data?after=next', cursors: { after: 'next' } } }) });
  await assert.rejects(unsafe.listScheduledPosts({ pageId: '123', pageToken: 'page-token' }), { code: 'META_INVALID_RESPONSE' });
});

test('post status requires explicit publication proof instead of an object ID alone', async () => {
  const missing = createMetaProvider(cfg, { fetchImpl: async () => response({ id: '123_456' }) });
  await assert.rejects(missing.getPostStatus({ postId: '123_456', pageToken: 'page-token' }), { code: 'META_INVALID_RESPONSE' });
  const published = createMetaProvider(cfg, { fetchImpl: async () => response({ id: '123_456', is_published: true, created_time: '2026-10-04T13:00:00+0000' }) });
  assert.equal((await published.getPostStatus({ postId: '123_456', pageToken: 'page-token' })).isPublished, true);
});
