import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../src/db.js';
import { createMetaProvider } from '../src/providers/meta.js';
import { contentHash, createDailyBatch, freshEnoughForPublication, handleApprovalCommand, publishDue, repeatsRememberedTopic, scheduleBatch } from '../src/workflow.js';

const sender = '+5511999999999';
const approvalTime = new Date('2026-09-24T10:00:00Z');
const dueTime = new Date('2026-09-24T13:08:00Z');
const config = { allowedSenders: [sender], approvalRequired: true, timezone: 'America/Sao_Paulo', metaPublishEnabled: true, metaPageId: '123', metaPageToken: 'test-token' };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vvc-workflow-'));
  const stores = [];
  const connect = async () => {
    const db = await openDatabase(dir);
    const store = createStore(db);
    stores.push(store);
    return { db, store };
  };
  t.after(async () => {
    for (const store of stores) { try { store.close(); } catch {} }
    await rm(dir, { recursive: true, force: true });
  });
  const { db, store } = await connect();
  const image = await readFile(new URL('../assets/brand/logo.png', import.meta.url));
  const imagePath = join(dir, 'preview.png');
  await writeFile(imagePath, image);
  store.createBatch({ id: 'batch_test', createdAt: approvalTime.toISOString() });
  for (let slot = 1; slot <= 8; slot += 1) {
    const post = { id: 'post_' + slot, batchId: 'batch_test', slot, category: slot <= 4 ? 'curiosity' : 'news', topic: 'teste-' + slot, headline: 'Teste ' + slot, caption: 'Legenda ' + slot, sources: [{ url: 'https://example.test/source' }], trend: {}, imagePath };
    const digest = contentHash({ ...post, imageBuffer: image });
    store.insertPost({ ...post, version: digest.slice(0, 16), contentHash: digest });
  }
  const approve = (id, now = approvalTime) => handleApprovalCommand({ text: 'APROVAR ' + id + ' ' + store.getPost(id).version.slice(0, 8), sender, config, store, now });
  const schedule = async () => { for (let slot = 1; slot <= 8; slot += 1) await approve('post_' + slot); };
  const command = (text, now = dueTime) => handleApprovalCommand({ text, sender, config, store, now });
  return { dir, db, store, image, imagePath, connect, approve, schedule, command };
}

test('each approved post is scheduled immediately into the next free Brasilia slot', async (t) => {
  const f = await fixture(t);
  await assert.rejects(handleApprovalCommand({ text: 'APROVAR post_1 deadbeef', sender: 'other', config, store: f.store }), { code: 'UNAUTHORIZED_SENDER' });
  await assert.rejects(f.command('APROVAR post_1 deadbeef'), { code: 'STALE_VERSION' });
  for (let slot = 1; slot <= 7; slot += 1) await f.approve('post_' + slot);
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
  assert.match(f.store.getPost('post_1').scheduled_at, /T10:00:00-03:00$/);
  assert.equal(scheduleBatch({ store: f.store, config, batchId: 'batch_test' }).reason, 'no_approved_posts');
  assert.match((await f.approve('post_8', new Date('2026-09-24T14:00:00Z'))).text, /agendad/);
  const times = f.store.getBatch('batch_test').posts.map((post) => post.scheduled_at);
  assert.equal(new Set(times).size, 8);
  assert.ok(times.every(Boolean));
  assert.ok(new Date(f.store.getPost('post_8').scheduled_at) > new Date('2026-09-24T14:00:00Z'));
});

test('unique preview codes approve and reject the intended post across concurrent batches', async (t) => {
  const f = await fixture(t);
  const first = f.store.getPost('post_1');
  const second = f.store.getPost('post_2');
  await f.command(`APROVAR ${first.version.slice(0, 8).toUpperCase()}`, approvalTime);
  await f.command(`REJEITAR ${second.version.slice(0, 8).toUpperCase()}`, approvalTime);
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
  assert.equal(f.store.getPost('post_2').status, 'rejected');
});

test('sequential zero-padded preview numbers resolve globally without depending on slots', async (t) => {
  const f = await fixture(t);
  const firstCode = f.store.approvalCode('post_1');
  const secondCode = f.store.approvalCode('post_2');
  assert.match(firstCode, /^0\d{3,}$/);
  assert.notEqual(firstCode, secondCode);
  await f.command(`APROVAR ${firstCode}`, approvalTime);
  await f.command(`REJEITAR ${secondCode}`, approvalTime);
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
  assert.equal(f.store.getPost('post_2').status, 'rejected');
});

test('approval rejects an image changed since preview, but allows the restored reviewed bytes', async (t) => {
  const f = await fixture(t);
  await writeFile(f.imagePath, 'changed image');
  await assert.rejects(f.approve('post_1'), { code: 'CONTENT_CHANGED' });
  assert.equal(f.store.getPost('post_1').approved_at, null);
  await writeFile(f.imagePath, f.image);
  await f.approve('post_1');
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
  assert.match(f.store.getPost('post_1').scheduled_at, /T10:00:00-03:00$/);
});

test('pause actually blocks publication and resume moves reserved posts to future slots', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  await f.command('PAUSAR batch_test');
  let calls = 0;
  const meta = { publishPhoto: async () => { calls += 1; return { id: '1' }; } };
  assert.equal((await publishDue({ store: f.store, meta, config, now: dueTime })).published, 0);
  assert.equal(calls, 0);
  await f.command('RETOMAR batch_test');
  assert.equal(f.store.getBatch('batch_test').status, 'scheduled');
  assert.ok(f.store.getBatch('batch_test').posts.every((post) => new Date(post.scheduled_at) > dueTime));
  assert.equal((await publishDue({ store: f.store, meta, config, now: dueTime })).published, 0);
});

test('politics and technology expire after 24h before Meta publication', async (t) => {
  const f = await fixture(t);
  await f.approve('post_1');
  f.db.prepare('UPDATE posts SET topic=? WHERE id=?').run('Política do governo brasileiro', 'post_1');
  let calls = 0;
  await publishDue({ store: f.store, config, now: new Date('2026-09-24T13:08:00Z'), meta: { publishPhoto: async () => { calls += 1; return { id: 'x' }; } } });
  assert.equal(calls, 0);
  assert.equal(f.store.getPost('post_1').status, 'rejected');
  assert.equal(f.store.getPost('post_1').last_error, 'FRESHNESS_EXPIRED');
});

test('overdue posts move forward without a catch-up publishing burst', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  const now = new Date('2026-09-25T01:00:00Z');
  assert.equal((await publishDue({ store: f.store, config, now, meta: { publishPhoto: async () => assert.fail('must reschedule overdue posts') } })).published, 0);
  const times = f.store.getBatch('batch_test').posts.map((post) => post.scheduled_at);
  assert.equal(new Set(times).size, 8);
  assert.ok(times.every((at) => new Date(at) > now));
});

test('rejected and restored invalidated posts can be explicitly reapproved inside a scheduled batch', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  const secondSlot = f.store.getPost('post_2').scheduled_at;
  await f.command('REJEITAR post_1');
  assert.equal(f.store.getPost('post_1').scheduled_at, null);
  await f.approve('post_1', dueTime);
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
  assert.ok(new Date(f.store.getPost('post_1').scheduled_at) > dueTime);
  assert.equal(f.store.getPost('post_2').scheduled_at, secondSlot);
  f.store.reschedule('post_1', '2026-09-24T10:00:00-03:00');
  await writeFile(f.imagePath, 'changed');
  await publishDue({ store: f.store, config, now: dueTime, meta: { publishPhoto: async () => assert.fail('integrity must block publication') } });
  assert.equal(f.store.getPost('post_1').status, 'pending_approval');
  await assert.rejects(f.approve('post_1'), { code: 'CONTENT_CHANGED' });
  await writeFile(f.imagePath, f.image);
  await f.approve('post_1', dueTime);
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
  assert.ok(new Date(f.store.getPost('post_1').scheduled_at) > dueTime);
});

test('two independent SQLite connections cannot publish the same due post or another concurrent post', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  f.store.reschedule('post_2', f.store.getPost('post_1').scheduled_at);
  const other = await f.connect();
  let calls = 0, release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const meta = { publishPhoto: async () => { calls += 1; entered(); await pending; return { id: '12345' }; } };
  const first = publishDue({ store: f.store, meta, config, now: dueTime });
  await started;
  assert.equal((await publishDue({ store: other.store, meta, config, now: dueTime })).published, 0);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).published, 1);
  assert.equal(calls, 1);
  assert.equal(f.store.getPost('post_1').status, 'published');
  assert.equal(f.store.getPost('post_2').status, 'scheduled');
});

test('a crash leaves a durable publishing claim which is never retried after restart', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  const post = f.store.getPost('post_1');
  assert.equal(f.store.claimPublication(post.id, dueTime.toISOString(), '2026-09-24T11:53:00Z', '2026-09-24T11:08:00Z', post), true);
  f.store.close();
  const restarted = await f.connect();
  await publishDue({ store: restarted.store, config, now: dueTime, meta: { publishPhoto: async () => assert.fail('cannot retry a possibly sent request') } });
  assert.equal(restarted.store.getPost('post_1').status, 'publishing');
});

for (const [code, expected] of [['PUBLICATION_UNKNOWN', 'publication_unknown'], ['META_REJECTED', 'publication_failed']]) {
  test(code + ' is persisted and never automatically retried or approved', async (t) => {
    const f = await fixture(t);
    await f.schedule();
    let calls = 0;
    const meta = { publishPhoto: async () => { calls += 1; throw Object.assign(new Error('test'), { code }); } };
    await publishDue({ store: f.store, meta, config, now: dueTime });
    assert.equal(f.store.getPost('post_1').status, expected);
    const restarted = await f.connect();
    await publishDue({ store: restarted.store, meta, config, now: dueTime });
    await assert.rejects(f.approve('post_1'), { code: 'POST_NOT_PENDING' });
    assert.equal(calls, 1);
  });
}

test('publication claim rejects a caption changed by another connection after integrity verification', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  const other = await f.connect();
  const claim = f.store.claimPublication.bind(f.store);
  f.store.claimPublication = (...args) => {
    other.db.prepare('UPDATE posts SET caption=? WHERE id=?').run('Changed after read', 'post_1');
    return claim(...args);
  };
  const meta = { publishPhoto: async () => assert.fail('stale verified snapshot must not claim') };
  await publishDue({ store: f.store, meta, config, now: dueTime });
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
  await publishDue({ store: f.store, meta, config, now: dueTime });
  assert.equal(f.store.getPost('post_1').status, 'pending_approval');
});

test('a pause committed by another connection immediately before the claim prevents the send', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  const other = await f.connect();
  const claim = f.store.claimPublication.bind(f.store);
  f.store.claimPublication = (...args) => {
    other.store.setBatchStatus('batch_test', 'paused');
    return claim(...args);
  };
  assert.equal((await publishDue({ store: f.store, config, now: dueTime, meta: { publishPhoto: async () => assert.fail('pause must win before claim') } })).published, 0);
  assert.equal(f.store.getPost('post_1').status, 'scheduled');
});

test('approval cannot authorize a caption changed after its integrity check', async (t) => {
  const f = await fixture(t);
  const other = await f.connect();
  const approve = f.store.approvePost.bind(f.store);
  f.store.approvePost = (...args) => {
    other.db.prepare('UPDATE posts SET caption=? WHERE id=?').run('Concurrent change', 'post_1');
    return approve(...args);
  };
  await assert.rejects(f.approve('post_1'), { code: 'POST_NOT_PENDING' });
  assert.equal(f.store.getPost('post_1').approved_at, null);
});

test('Meta receives exact verified image bytes even when the file changes after the durable claim', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  const claim = f.store.claimPublication.bind(f.store);
  f.store.claimPublication = (...args) => {
    const claimed = claim(...args);
    if (claimed) writeFileSync(f.imagePath, 'changed between hash and upload');
    return claimed;
  };
  let calls = 0;
  const meta = createMetaProvider({ metaAppSecret: 'test-secret' }, { fetchImpl: async (_url, request) => {
    calls += 1;
    assert.deepEqual(Buffer.from(await request.body.get('source').arrayBuffer()), f.image);
    assert.equal(request.body.get('caption'), 'Legenda 1');
    return new Response(JSON.stringify({ id: '12345', post_id: '123_12345' }));
  } });
  assert.equal((await publishDue({ store: f.store, meta, config, now: dueTime })).published, 1);
  assert.equal(calls, 1);
});

test('daily generation is reserved across connections and a failed incomplete day can be repaired', async (t) => {
  const f = await fixture(t);
  const other = await f.connect();
  let release, started, researchCalls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const researchStarted = new Promise((resolve) => { started = resolve; });
  const research = async () => { researchCalls += 1; started(); await pending; throw Object.assign(new Error('research unavailable'), { code: 'RESEARCH_FAILED' }); };
  const options = { config: { ...config, outputDir: f.dir }, ai: {}, research, now: approvalTime };
  const first = createDailyBatch({ ...options, store: f.store });
  const duplicate = await createDailyBatch({ ...options, store: other.store });
  assert.equal(duplicate.skipped, 'already_created_today');
  assert.equal(other.store.getBatch(duplicate.batchId).status, 'generating');
  await researchStarted;
  assert.equal(researchCalls, 1);
  release();
  await assert.rejects(first, { code: 'RESEARCH_FAILED' });
  assert.equal(other.store.getBatch(duplicate.batchId).status, 'blocked');
  await assert.rejects(createDailyBatch({ ...options, store: other.store }), { code: 'RESEARCH_FAILED' });
  assert.equal(researchCalls, 2);
});

test('repair preserves approved posts and regenerates only rejected or missing slots', async (t) => {
  const f = await fixture(t);
  f.db.prepare('UPDATE batches SET local_day=?,status=? WHERE id=?').run('2026-09-24', 'blocked', 'batch_test');
  await f.approve('post_4');
  f.store.rejectPost('post_3');
  for (const id of ['post_5','post_6','post_7','post_8']) f.db.prepare('DELETE FROM posts WHERE id=?').run(id);
  const approvedBefore = f.store.getPost('post_4');
  const candidates = [
    { id: 'c3', category: 'curiosity', publishable: true, topic: 'nova-curiosidade', sources: [{ url: 'https://example.test/c3' }], trend: {} },
    ...Array.from({ length: 4 }, (_, index) => ({ id: 'n' + index, category: 'news', publishable: true, topic: 'nova-noticia-' + index, sources: [{ url: 'https://example.test/n' + index, publishedAt: approvalTime.toISOString() }], trend: {} })),
  ];
  const result = await createDailyBatch({
    config: { ...config, outputDir: f.dir }, store: f.store, now: approvalTime, targetDay: '2026-09-24',
    research: async () => ({ candidates, warnings: [] }),
    ai: { generateCopy: async (candidate) => ({ headline: candidate.topic, caption: 'Legenda', highlights: [], imagePrompt: 'prompt' }), generateImage: async () => ({ buffer: f.image }) },
    renderer: async ({ imageBuffer, outputPath }) => writeFile(outputPath, imageBuffer),
    messenger: { send: async () => {} },
  });
  const batch = f.store.getBatch('batch_test');
  assert.equal(result.repaired, true);
  assert.equal(result.selected, 5);
  assert.equal(batch.posts.length, 8);
  assert.equal(batch.status, 'scheduled');
  assert.equal(f.store.getPost('post_4').status, 'scheduled');
  assert.equal(f.store.getPost('post_4').version, approvedBefore.version);
  assert.ok(batch.posts.find((post) => post.slot === 3).id !== 'post_3');
  assert.ok(batch.posts.filter((post) => [3,5,6,7,8].includes(post.slot)).every((post) => post.status === 'pending_approval'));
});

test('an incomplete search generates every available replacement instead of discarding partial progress', async (t) => {
  const f = await fixture(t);
  f.db.prepare('UPDATE batches SET local_day=?,status=? WHERE id=?').run('2026-09-24', 'blocked', 'batch_test');
  for (const id of ['post_1','post_2','post_3','post_4','post_5','post_6','post_7','post_8']) f.store.rejectPost(id);
  const candidates = [
    { id: 'c1', category: 'curiosity', publishable: true, topic: 'curiosidade parcial nova', sources: [{ url: 'https://new.test/c1' }], trend: {} },
    { id: 'n1', category: 'news', publishable: true, topic: 'notícia parcial nova', sources: [{ url: 'https://new.test/n1', publishedAt: approvalTime.toISOString() }], trend: {} },
  ];
  const result = await createDailyBatch({
    config: { ...config, outputDir: f.dir }, store: f.store, now: approvalTime, targetDay: '2026-09-24',
    research: async () => ({ candidates, warnings: [] }),
    ai: { generateCopy: async (candidate) => ({ headline: candidate.topic, caption: 'Legenda', highlights: [], imagePrompt: 'prompt' }), generateImage: async () => ({ buffer: f.image }) },
    renderer: async ({ imageBuffer, outputPath }) => writeFile(outputPath, imageBuffer),
    messenger: { send: async () => {} },
  });
  const batch = f.store.getBatch('batch_test');
  assert.equal(result.selected, 2);
  assert.equal(result.partial, true);
  assert.deepEqual(result.remaining, { curiosity: 3, news: 3 });
  assert.equal(batch.posts.filter((post) => post.status === 'pending_approval').length, 2);
  assert.match(batch.warning, /faltam 3 curiosidades e 3 notícias/);
});

test('topic memory survives rejected-slot deletion and blocks repeated sources or substantially similar topics', async (t) => {
  const f = await fixture(t);
  f.store.rejectPost('post_1');
  f.store.removeRejectedSlot('batch_test', 1);
  const memories = f.store.topicMemory();
  assert.ok(memories.some((item) => item.post_id === 'post_1'));
  assert.equal(repeatsRememberedTopic({ topic: 'Tema diferente', sources: [{ url: 'https://example.test/source?utm_source=x' }] }, memories), true);
  assert.equal(repeatsRememberedTopic({ topic: 'Teste 1 volta com outras palavras', summary: 'Teste 1 novamente', sources: [] }, memories), true);
  assert.equal(repeatsRememberedTopic({ topic: 'Descoberta inédita sobre oceanos profundos', sources: [{ url: 'https://other.test/new' }] }, memories), false);
});

test('topic memory blocks the same story but allows new AI themes to learn from performance', () => {
  const memories = [{ topic: 'Claude model advances artificial intelligence', headline: 'Novo modelo de IA', sources: [{ url: 'https://example.test/claude' }] }];
  assert.equal(repeatsRememberedTopic({ topic: 'Companies ask for AI regulation', sources: [{ url: 'https://other.test/regulation' }] }, memories), false);
  assert.equal(repeatsRememberedTopic({ topic: 'Claude model advances artificial intelligence again', sources: [{ url: 'https://example.test/claude' }] }, memories), true);
  assert.equal(repeatsRememberedTopic({ topic: 'Nova espécie encontrada no oceano', sources: [] }, memories), false);
});

test('politics and technology require a source from the last 24 hours while other topics may be older', () => {
  const current = new Date('2026-09-26T12:00:00Z');
  const stale = { topic: 'Brazil plans decree to ban online casinos', category: 'curiosity', sources: [{ publishedAt: '2026-09-25T00:00:00Z' }] };
  const fresh = { ...stale, sources: [{ publishedAt: '2026-09-26T00:30:00Z' }] };
  assert.equal(freshEnoughForPublication(stale, current), false);
  assert.equal(freshEnoughForPublication(fresh, current), true);
  assert.equal(freshEnoughForPublication({ topic: 'Novo chip de inteligência artificial', category: 'news', sources: [{ publishedAt: '2026-09-25T00:00:00Z' }] }, current), false);
  assert.equal(freshEnoughForPublication({ topic: 'Descoberta médica extraordinária', category: 'news', sources: [{ publishedAt: '2026-08-30T00:00:00Z' }] }, current), true);
  assert.equal(freshEnoughForPublication({ topic: 'Polvos resolvem labirintos', category: 'curiosity', sources: [{ publishedAt: '2020-01-01T00:00:00Z' }] }, current), true);
});

test('a generated 4+4 batch needs explicit approval even when approvalRequired=false', async (t) => {
  const f = await fixture(t);
  const candidates = Array.from({ length: 8 }, (_, index) => ({ id: 'candidate-' + index, category: index < 4 ? 'curiosity' : 'news', publishable: true, topic: 'generated-' + index, sources: [{ url: 'https://example.test/fact-' + index, publishedAt: approvalTime.toISOString() }], trend: { label: 'recent' } }));
  const previews = [];
  const result = await createDailyBatch({
    config: { ...config, approvalRequired: false, outputDir: f.dir }, store: f.store, now: approvalTime,
    research: async () => ({ candidates, warnings: [] }),
    ai: { generateCopy: async (candidate) => ({ headline: candidate.topic, caption: 'Research-based caption', highlights: [], imagePrompt: 'prompt' }), generateImage: async () => ({ buffer: f.image }) },
    renderer: async ({ imageBuffer, outputPath }) => writeFile(outputPath, imageBuffer),
    messenger: { send: async (preview) => { previews.push(preview); } },
  });
  assert.equal(result.selected, 8);
  const batch = f.store.getBatch(result.batchId);
  assert.equal(batch.status, 'pending_approval');
  assert.equal(previews.filter((preview) => preview.imagePath).length, 8);
  assert.equal(batch.posts.filter((post) => post.category === 'news').length, 4);
  assert.ok(batch.posts.every((post) => post.status === 'pending_approval' && !post.approved_at && !post.scheduled_at && post.content_hash));
});

test('research progress is summarized, serialized and drained before reporting a blocked batch', async (t) => {
  const f = await fixture(t);
  const messages = [];
  let active = 0, maximum = 0;
  const result = await createDailyBatch({
    config, store: f.store, now: approvalTime, ai: { generateCopy: () => assert.fail('blocked research cannot call AI') },
    research: async (_config, { onProgress }) => {
      for (let index = 0; index < 40; index += 1) {
        onProgress({ type: 'research_started', args: ['private query'] });
        onProgress({ type: 'verification_started', candidateId: 'private candidate' });
        onProgress({ type: 'verification_finished', candidateId: 'private candidate' });
      }
      return { candidates: [], warnings: [] };
    },
    messenger: { send: async ({ text }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      messages.push(text);
      active -= 1;
    } },
  });
  assert.equal(result.blocked, 'insufficient_topics');
  assert.ok(messages.length >= 2);
  assert.equal(messages.filter((text) => text.includes('qualidade')).length, 0);
  assert.match(messages.at(-1), /faltam algumas pautas|preservado/i);
  assert.ok(messages.every((text) => !text.includes('private')));
  assert.equal(maximum, 1);
  assert.equal(active, 0);
});

test('AI and research failures notify only safe codes and await the final notice', async (t) => {
  for (const useUnsafeCode of [false, true]) {
    const f = await fixture(t);
    const messages = [];
    const candidates = Array.from({ length: 8 }, (_, index) => ({ id: 'candidate-' + index, category: index < 4 ? 'curiosity' : 'news', publishable: true, topic: 'candidate-' + index, sources: [{ url: 'https://example.test/failure-' + index, publishedAt: approvalTime.toISOString() }] }));
    const failure = Object.assign(new Error('private provider response and token'), { code: useUnsafeCode ? 'token=private\nsecret' : 'AI_QUOTA' });
    await assert.rejects(createDailyBatch({
      config: { ...config, outputDir: f.dir }, store: f.store, now: approvalTime,
      research: async () => { if (useUnsafeCode) throw failure; return { candidates, warnings: [] }; },
      ai: { generateCopy: async () => { throw failure; } },
      messenger: { send: async ({ text }) => { await Promise.resolve(); messages.push(text); } },
    }), (error) => error === failure);
    assert.match(messages.at(-1), /não consegui concluir|preservado/i);
    assert.ok(messages.every((text) => !text.includes('private') && !text.includes('secret')));
    assert.equal(f.store.batchForDay('2026-09-24').status, 'blocked');
  }
});
