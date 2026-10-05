import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTopicPlan, approveTopicPlan, readTopicPlan, listTopicPlans, researchForApprovedPlan, formatTopicPlanMessages, topicPlanScore, markTopicPlanConsumed, invalidateNonFacebookPlans, isFacebookBasedCandidate } from '../src/topic-plan.js';

const now = new Date('2026-10-04T12:00:00Z');
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vvc-topic-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dataDir: dir, timezone: 'America/Sao_Paulo' };
}
function candidate(index, overrides = {}) {
  return { id: `candidate-${index}`, topic: `Animal extraordinário número ${index}`, category: 'curiosity', publishable: true,
    sources: [{ id: `source-${index}`, url: `https://facebook.com/story/posts/${index}`, source: 'Página de referência', text: `Animal extraordinário número ${index}`, publishedAt: '2026-10-04T10:00:00Z', metrics: { likes: index * 10 }, provenance: { engine: 'scrapling', kind: 'source-item' } }],
    raw: { engine: 'scrapling', inspirationKind: 'facebook' }, ...overrides };
}

test('topic plan persists private snapshots, selects four per category and prioritizes Facebook posts', async (t) => {
  const config = await setup(t);
  const candidates = Array.from({ length: 10 }, (_, index) => candidate(index + 1, { category: index < 5 ? 'curiosity' : 'news' }));
  candidates.unshift(candidate(99, { raw: { engine: 'last30days' } }));
  const plan = await createTopicPlan({ config, result: { candidates }, now });
  assert.match(plan.id, /^[a-f0-9]{8}$/u);
  assert.equal(plan.targetDay, '2026-10-04');
  assert.equal(plan.items.length, 8);
  assert.equal(plan.items.filter((item) => item.candidate.category === 'curiosity').length, 4);
  assert.equal(plan.items[0].candidate.id, 'candidate-5');
  assert.deepEqual(plan.approvedIndices, []);
  assert.equal(plan.status, 'pending');
  assert.deepEqual((await readTopicPlan({ config, id: plan.id })).items, plan.items);
  assert.equal((await stat(join(config.dataDir, 'topic-plans', `${plan.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(config.dataDir, 'topic-plans'))).mode & 0o777, 0o700);
  assert.equal((await listTopicPlans({ config })).length, 1);
  assert.throws(() => researchForApprovedPlan(plan, { now }), { code: 'TOPIC_PLAN_APPROVAL_REQUIRED' });
});

test('plan filters blocked, stale urgent and remembered stories; empty plans do not persist', async (t) => {
  const config = await setup(t);
  const store = { topicMemory: () => [{ topic: 'Animal extraordinário número 1', sources: [] }] };
  await assert.rejects(createTopicPlan({ config, store, now, result: { candidates: [candidate(1), candidate(2, { publishable: false }), candidate(3, { topic: 'OpenAI lança modelo novo', sources: [{ ...candidate(3).sources[0], publishedAt: null }] })] } }), { code: 'TOPIC_PLAN_EMPTY' });
  assert.deepEqual(await listTopicPlans({ config }), []);
});

test('approvals validate indices, merge idempotently under concurrent writes, and generate only approved themes', async (t) => {
  const config = await setup(t);
  const plan = await createTopicPlan({ config, now, result: { candidates: [candidate(1), candidate(2), candidate(3)] } });
  await assert.rejects(approveTopicPlan({ config, id: plan.id, indices: [1, 99], now }), { code: 'TOPIC_PLAN_SELECTION_INVALID' });
  assert.deepEqual((await readTopicPlan({ config, id: plan.id })).approvedIndices, []);
  await Promise.all([approveTopicPlan({ config, id: plan.id, indices: [1], now }), approveTopicPlan({ config, id: plan.id, selection: '2', now })]);
  let approved = await approveTopicPlan({ config, id: plan.id, indices: [1], now });
  assert.deepEqual(approved.approvedIndices, [1, 2]);
  const research = researchForApprovedPlan(approved, { now });
  assert.equal(research.candidates.length, 2);
  research.candidates[0].topic = 'Mutated';
  assert.notEqual(approved.items[0].candidate.topic, 'Mutated');
  approved = await approveTopicPlan({ config, id: plan.id, selection: 'TODAS', now });
  assert.deepEqual(approved.approvedIndices, [1, 2, 3]);
  const consumed = await markTopicPlanConsumed({ config, id: plan.id, now });
  assert.equal(consumed.status, 'consumed');
  assert.throws(() => researchForApprovedPlan(consumed, { now }), { code: 'TOPIC_PLAN_APPROVAL_REQUIRED' });
});

test('approved urgent themes expire before generation and are never revived by collection time', async (t) => {
  const config = await setup(t);
  const plan = await createTopicPlan({ config, now, result: { candidates: [candidate(1, { topic: 'OpenAI anuncia modelo novo', category: 'news' })] } });
  const approved = await approveTopicPlan({ config, id: plan.id, all: true, now });
  const tomorrow = new Date('2026-10-05T12:00:00Z');
  assert.throws(() => researchForApprovedPlan(approved, { now: tomorrow }), { code: 'TOPIC_PLAN_EXPIRED' });
  await assert.rejects(approveTopicPlan({ config, id: plan.id, all: true, now: tomorrow }), { code: 'TOPIC_PLAN_EXPIRED' });
});

test('real metrics and score distinguish unavailable counters from measured zero and WhatsApp messages stay bounded', async (t) => {
  const config = await setup(t);
  const missing = candidate(1);
  missing.sources[0].metrics = { score: 10000 };
  assert.deepEqual(topicPlanScore(missing).available, false);
  const zero = candidate(2);
  zero.sources[0].metrics = { likes: 0 };
  assert.equal(topicPlanScore(zero).available, true);
  assert.equal(topicPlanScore(zero).value, 0);
  const measured = candidate(3);
  measured.sources[0].metrics = { likes: 9, comments: 9, shares: 9, views: 9 };
  assert.equal(topicPlanScore(measured).value, Math.round(4.5 * Math.log(10) * 100) / 100);
  const plan = await createTopicPlan({ config, now, result: { candidates: [missing, zero, measured, ...Array.from({ length: 5 }, (_, index) => candidate(index + 4, { topic: index + ' Fato interessante muito longo '.repeat(20), category: 'news' }))] } });
  const messages = formatTopicPlanMessages(plan);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 3500));
  const contents = messages.join('\n');
  assert.match(contents, /Curtidas:\* indisponível/u);
  assert.match(contents, /Curtidas:\* 0/u);
  assert.match(contents, /não é garantia de viralização/u);
  assert.match(contents, new RegExp(`APROVAR TEMAS TODOS`));
  assert.match(contents, /Base:\* https:\/\/facebook.com\/story\/posts\//u);
});

test('score uses the same source displayed as base and rejects unassociated profile metrics', async (t) => {
  const config = await setup(t);
  const post = candidate(1);
  post.sources[0].metrics = { likes: 9 };
  post.sources.push({ id: 'other', url: 'https://reddit.com/post', source: 'Reddit', text: 'Discussão', metrics: { comments: 999999 }, provenance: { engine: 'last30days' } });
  assert.equal(topicPlanScore(post).value, Math.round(Math.log(10) * 100) / 100);
  assert.equal(topicPlanScore(post).partial, true);
  const profile = candidate(2);
  profile.sources[0].provenance.kind = 'profile-post';
  profile.sources[0].metrics = { likes: 12345 };
  assert.equal(topicPlanScore(profile).available, false);
  const plan = await createTopicPlan({ config, now, result: { candidates: [post, profile] } });
  const contents = formatTopicPlanMessages(plan).join('\n');
  assert.match(contents, /página - link do post indisponível/u);
  assert.doesNotMatch(contents, /999\.999|12\.345/u);
  assert.match(contents, /Score: 2.30 \(parcial\)/u);
  assert.deepEqual(plan.items.find((item) => item.candidate.id === profile.id).metricsAvailable, []);
});

test('untrusted plan identifiers cannot escape the private directory', async (t) => {
  const config = await setup(t);
  for (const id of ['../../private', '123', 'abcdef01/other', 'ABCDEF01']) await assert.rejects(readTopicPlan({ config, id }), { code: 'TOPIC_PLAN_ID_INVALID' });
});

test('strict Facebook base retains only page posts while complementary sources corroborate', async (t) => {
  const config = { ...await setup(t), facebookBaseRequired: true };
  const fb = candidate(1);
  fb.sources.push({ id: 'corroboration', url: 'https://bbc.com/story', text: 'Contexto adicional', metrics: {}, provenance: { engine: 'last30days', kind: 'source-item' } });
  const complementary = candidate(2, { raw: { engine: 'last30days' } });
  complementary.sources[0].url = 'https://github.com/org/project/issues/1';
  complementary.sources[0].provenance.engine = 'last30days';
  const forged = candidate(3);
  forged.sources[0].url = 'https://facebook.com.fake.test/post';
  assert.equal(isFacebookBasedCandidate(forged), false);
  const plan = await createTopicPlan({ config, now, result: { candidates: [fb, complementary, forged] } });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].candidate.id, fb.id);
  assert.equal(plan.items[0].candidate.sources.length, 2);
  assert.equal(plan.facebookBaseRequired, true);
  assert.deepEqual(plan.remaining, { curiosity: 3, news: 4 });
  const approved = await approveTopicPlan({ config, id: plan.id, all: true, now });
  assert.equal(researchForApprovedPlan(approved, { config, now }).candidates.length, 1);
  await assert.rejects(createTopicPlan({ config, now, result: { candidates: [complementary] } }), { code: 'TOPIC_PLAN_EMPTY' });
});

test('strict base permits observed Facebook post text without permalink and reports unknown counters', async (t) => {
  const config = { ...await setup(t), facebookBaseRequired: true };
  const post = candidate(1);
  post.sources[0].url = 'https://facebook.com/reference';
  post.sources[0].provenance.kind = 'profile-post';
  const plan = await createTopicPlan({ config, now, result: { candidates: [post] } });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].score.available, false);
});

test('pending and approved legacy mixed plans are superseded without erasing snapshots or consuming posts', async (t) => {
  const config = await setup(t);
  const complementary = candidate(2, { raw: { engine: 'last30days' } });
  complementary.sources[0].url = 'https://news.test/story';
  complementary.sources[0].provenance.engine = 'last30days';
  const pending = await createTopicPlan({ config, now, result: { candidates: [candidate(1), complementary] } });
  const approvedPlan = await createTopicPlan({ config, now, result: { candidates: [complementary] } });
  const approved = await approveTopicPlan({ config, id: approvedPlan.id, all: true, now });
  const fbOnly = await createTopicPlan({ config, now, result: { candidates: [candidate(3)] } });
  const strict = { ...config, facebookBaseRequired: true };
  assert.throws(() => researchForApprovedPlan(approved, { config: strict, now }), { code: 'TOPIC_PLAN_FACEBOOK_BASE_REQUIRED' });
  const result = await invalidateNonFacebookPlans({ config: strict, now });
  assert.equal(result.count, 2);
  const saved = await readTopicPlan({ config, id: pending.id });
  assert.equal(saved.status, 'superseded');
  assert.deepEqual(saved.items, pending.items);
  assert.equal((await readTopicPlan({ config, id: fbOnly.id })).status, 'pending');
  await assert.rejects(approveTopicPlan({ config, id: pending.id, all: true, now }), { code: 'TOPIC_PLAN_SUPERSEDED' });
  assert.throws(() => researchForApprovedPlan({ ...approved, status: 'superseded' }, { now }), { code: 'TOPIC_PLAN_SUPERSEDED' });
  assert.equal((await invalidateNonFacebookPlans(strict)).count, 0);
});
