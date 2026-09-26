import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeReport, researchTopics, verifyCandidates } from '../src/research.js';

const now = new Date('2026-09-24T12:00:00Z');
const current = '2026-09-23T12:00:00Z';
function flat(title = 'Peixe que anda', overrides = {}) {
  return { title, url: `https://reddit.com/r/science/${encodeURIComponent(title)}`, source: 'reddit', summary: 'Discussão recente do tema.', published_at: current, engagement: { score: 120, num_comments: 12 }, relevance_score: 0.9, ...overrides };
}
function candidate(category = 'curiosity', overrides = {}) {
  return normalizeReport({ categoryHint: category, results: [flat('Peixe que anda', overrides)] }, now, 15)[0];
}
function evidence(url = 'https://institute.edu/study', overrides = {}) {
  return { url, title: 'Estudo original', text: 'O estudo documenta o comportamento locomotor desta espécie em condições observadas.', publishedAt: current, retrievedAt: now.toISOString(), retrievalMethod: 'web-fetch', verified: true, isPrimary: true, primaryReason: 'Artigo original dos pesquisadores responsáveis pelo estudo.', ...overrides };
}
function verified(sources = [evidence()], overrides = {}) {
  return { verdict: 'verified', explanation: 'O fato está documentado nas fontes.', sources, claims: [{ text: 'Esta espécie apresenta o comportamento observado.', sourceUrls: sources.map((source) => source.url) }], ...overrides };
}
async function check(item, assessment, options = {}) {
  return (await verifyCandidates([item], { now, verifyImpl: async () => assessment, ...options }))[0];
}
async function research(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vvc-research-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return researchTopics({ last30daysDir: dir, pythonBin: 'python3', researchTimeoutMs: 1_000 }, { now, clock: () => now, ...options });
}

test('discovery is candidate evidence, never manufactured factual proof or per-URL engagement', () => {
  const [item] = normalizeReport({ kind: 'discovery', results: [{ topic: 'IA descobre animal', why_spiking: 'viral', velocity_score: 82, corroboration_count: 9, published_at: current, evidence_urls: ['https://a.test/article', 'https://b.test/article'], engagement: { hackernews: { points: 120 } } }] }, now, 15);
  assert.equal(item.category, 'news');
  assert.equal(item.trend.score, 82);
  assert.deepEqual(item.trend.signals, []);
  assert.equal(item.trend.aggregateMetrics.hackernews.points, 120);
  assert.ok(item.sources.every((source) => source.publishedAt === null && source.text === '' && !source.isPrimary));
  assert.equal(item.publishable, false);
  assert.equal(item.evidenceStatus, 'candidate');
  assert.ok(item.blockedReasons.includes('NO_RECENT_DATED_TREND_SIGNAL'));
});

test('raw discovery topics keep aggregate metrics without attributing them to linked pages', () => {
  const [item] = normalizeReport({ topics: [{ name: 'Animal que brilha', why_spiking: 'popular', velocity_score: 76, evidence_urls: ['https://a.test'], engagement_by_source: { hackernews: { points: 50, comments: 12 } } }] }, now, 15);
  assert.equal(item.topic, 'Animal que brilha');
  assert.equal(item.trend.aggregateMetrics.hackernews.points, 50);
  assert.deepEqual(item.trend.signals, []);
});

test('raw candidates preserve each source date, body and native counters', () => {
  const [item] = normalizeReport({ categoryHint: 'curiosity', ranked_candidates: [{ title: 'Pesquisa sobre um peixe', url: 'https://reddit.com/a', snippet: 'Resumo agregado.', final_score: 92, engagement: 999, source_items: [
    { item_id: 'r1', source: 'reddit', title: 'Conversa', url: 'https://reddit.com/a', published_at: current, body: 'Somente texto da discussão.', engagement: { score: 25, num_comments: 3, rank: 999 } },
    { item_id: 'j1', source: 'journal', title: 'Artigo', url: 'https://journal.test/b', published_at: '2019-01-01', body: 'Somente texto do artigo.', engagement: {} },
  ] }] }, now, 15);
  assert.equal(item.category, 'curiosity');
  assert.equal(item.sources[0].text, 'Somente texto da discussão.');
  assert.equal(item.sources[1].publishedAt, '2019-01-01T00:00:00.000Z');
  assert.equal(item.sources[1].text, 'Somente texto do artigo.');
  assert.equal(item.trend.signals.length, 1);
  assert.equal(item.trend.signals[0].engagement, 25);
  assert.deepEqual(item.trend.signals[0].metrics, { score: 25, num_comments: 3 });
  assert.equal(item.trend.score, null);
  assert.equal(item.trend.rankingScore, 92);
  assert.equal(item.publishable, false);
});

test('versioned agent export fixture preserves per-result dates and counter semantics', async () => {
  const fixture = JSON.parse(await readFile(new URL('../data/last30days/vendor/last30days/tests/fixtures/agent_export_v1.json', import.meta.url), 'utf8'));
  const items = normalizeReport(fixture, new Date('2026-07-10T00:00:00Z'), 15);
  assert.equal(items.length, 3);
  assert.equal(items[0].sources[0].publishedAt, '2026-06-28T00:00:00.000Z');
  assert.equal(items[0].trend.signals[0].engagement, 1543);
  assert.equal(items[2].trend.signals[0].engagement, 5);
  assert.equal(items[2].sources[0].metrics.rank, undefined);
  assert.ok(items.every((item) => !item.publishable));
});

test('missing, stale, future and impossible dates never count as recent signals', async () => {
  for (const published_at of [undefined, '2026-09-09T11:59:59Z', '2026-09-25', '2026-02-31']) {
    const item = candidate('news', { published_at });
    assert.equal(item.trend.hasRecentSignal, false, String(published_at));
    const result = await check(item, verified());
    assert.equal(result.publishable, false);
    assert.ok(result.blockedReasons.includes('NO_RECENT_DATED_TREND_SIGNAL'));
  }
  assert.equal(candidate('curiosity', { published_at: '2026-09-09T12:00:00Z' }).trend.hasRecentSignal, true);
  assert.equal(candidate('curiosity', { engagement: { rank: 10, relevance_score: 1 } }).trend.hasRecentSignal, false);
});

test('verified curiosity may use an older primary article with a current last30days signal', async () => {
  const result = await check(candidate(), verified([evidence(undefined, { publishedAt: '2019-01-01' })]));
  assert.equal(result.publishable, true);
  assert.equal(result.evidenceStatus, 'verified');
  assert.deepEqual(result.blockedReasons, []);
  assert.equal(result.verification.claims[0].sourceIds[0], result.sources[0].id);
  assert.equal(result.discoverySources[0].source, 'reddit');
  assert.equal(result.trend.signals[0].engagement, 120);
});

test('news no longer needs recent primary reporting or two independent cited source domains', async () => {
  const item = candidate('news');
  const second = evidence('https://news.test/report', { isPrimary: false });
  assert.equal((await check(item, verified([evidence(), second]))).publishable, true);
  for (const publishedAt of [null, '2026-09-01', '2026-02-31']) {
    const result = await check(item, verified([evidence(undefined, { publishedAt }), second]));
    assert.equal(result.publishable, true, String(publishedAt));
  }
  const sameDomain = await check(item, verified([evidence(), evidence('https://news.institute.edu/report', { isPrimary: false })]));
  assert.equal(sameDomain.publishable, true);
  const uncited = await check(item, verified([evidence(), second], { claims: [{ text: 'O fato', sourceUrls: [evidence().url] }] }));
  assert.equal(uncited.publishable, true);
});

test('unsupported, ungrounded, and unfetched evidence blocks publication explicitly', async () => {
  const variants = [
    [verified([evidence()], { verdict: 'contradicted' }), 'CLAIM_CONTRADICTED'],
    [verified([evidence()], { claims: [] }), 'CLAIMS_WITHOUT_RETRIEVED_SOURCES'],
    [verified([evidence()], { claims: [{ text: 'Afirmação', sourceUrls: ['https://invented.test/'] }] }), 'CLAIMS_WITHOUT_RETRIEVED_SOURCES'],
    [verified([evidence(undefined, { verified: false })]), 'NO_RETRIEVED_SOURCE_EVIDENCE'],
    [verified([evidence(undefined, { retrievedAt: '2026-09-25' })]), 'NO_RETRIEVED_SOURCE_EVIDENCE'],
    [verified([evidence(undefined, { retrievalMethod: 'model-assertion' })]), 'NO_RETRIEVED_SOURCE_EVIDENCE'],
  ];
  for (const [assessment, reason] of variants) {
    const result = await check(candidate(), assessment);
    assert.equal(result.publishable, false, reason);
    assert.ok(result.blockedReasons.includes(reason), reason);
  }
  const [unconfigured] = await verifyCandidates([candidate()], { now });
  assert.ok(unconfigured.blockedReasons.includes('EDITORIAL_VERIFIER_NOT_CONFIGURED'));
  const [failed] = await verifyCandidates([candidate()], { now, verifyImpl: async () => { throw Object.assign(new Error('failure'), { code: 'FETCH_FAILED' }); } });
  assert.ok(failed.blockedReasons.includes('EDITORIAL_VERIFICATION_FAILED'));
});

test('verification evaluates fetched timestamps after work completes', async () => {
  const later = new Date('2026-09-24T12:05:00Z');
  const result = await check(candidate(), verified([evidence(undefined, { retrievedAt: later.toISOString() })]), { clock: () => later });
  assert.equal(result.publishable, true);
  assert.equal(result.verification.checkedAt, later.toISOString());
});

test('research keeps 15-day pinned engine contract and disables credential sources and cookies', async (t) => {
  const calls = [];
  const result = await research(t, { runImpl: async (call) => { calls.push(call); return { stdout: JSON.stringify({ results: [] }), stderr: '' }; } });
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.ok(call.scriptPath.endsWith('/vendor/last30days/skills/last30days/scripts/last30days.py'));
    assert.ok(call.args.includes('--days=15'));
    assert.ok(call.args.includes('--json-profile=raw'));
    assert.ok(call.args.includes('--no-browser-cookies'));
    assert.equal(call.timeoutMs, 1_000);
    assert.equal(call.env.LAST30DAYS_SKIP_KEYCHAIN, '1');
    assert.equal(call.env.LAST30DAYS_CONFIG_DIR, '');
    assert.equal(call.env.LAST30DAYS_TRUST_PROJECT_CONFIG, '0');
    assert.equal(call.env.SCRAPECREATORS_API_KEY, '');
    assert.equal(call.env.GOOGLE_API_KEY, '');
    assert.equal(call.env.LAST30DAYS_API_KEY, '');
    assert.equal(call.env.AUTH_TOKEN, '');
  }
  assert.equal(result.candidates.length, 0);
  assert.ok(result.warnings.some((warning) => warning.code === 'INSUFFICIENT_NEWS'));
});

test('cross-search duplicates merge evidence and preserve explicit topical category', async (t) => {
  const result = await research(t, { runImpl: async ({ args }) => ({ stdout: JSON.stringify(args[0] === '--discover'
    ? { topics: [{ name: 'Animal repetido', evidence_urls: ['https://www.reddit.com/r/science/a?utm_source=example'] }] }
    : { results: [flat('Outro título para o mesmo animal', { url: 'https://reddit.com/r/science/a' })] }), stderr: '' }) });
  assert.equal(result.counts.discovered, 7);
  assert.equal(result.counts.unique, 1);
  assert.equal(result.candidates[0].sources.length, 1);
  assert.equal(result.candidates[0].sources[0].text, 'Discussão recente do tema.');
  assert.equal(result.candidates[0].trend.hasRecentSignal, true);
  assert.equal(result.candidates[0].category, 'curiosity');
  assert.equal(result.candidates[0].raw.searches.length, 7);
});

test('truncation is fair across categories and searches and counts only verified items as available', async (t) => {
  const result = await research(t, { runImpl: async ({ args }) => ({ stdout: JSON.stringify({ results: Array.from({ length: 50 }, (_, index) => flat(`${args[0]} item ${index}`)) }), stderr: '' }) });
  assert.equal(result.counts.discovered, 350);
  assert.equal(result.candidates.length, 16);
  assert.equal(result.counts.retainedByCategory.news, 8);
  assert.equal(result.counts.retainedByCategory.curiosity, 8);
  for (const topic of ['unusual animals', 'strange foods', 'space mysteries', 'unusual countries traditions', 'science medicine breakthrough', 'AI technology innovation']) assert.ok(result.candidates.some((item) => item.topic.startsWith(topic)), topic);
  assert.deepEqual(result.counts.verified, { curiosity: 0, news: 0 });
  assert.ok(result.warnings.some((warning) => warning.code === 'CANDIDATES_TRUNCATED'));
  assert.ok(result.warnings.some((warning) => warning.code === 'INSUFFICIENT_NEWS' && warning.available === 0 && warning.discovered > 0));
});

test('research invokes trusted verifier, records coverage failures and returns reviewed candidates', async (t) => {
  const events = [];
  const result = await research(t, {
    runImpl: async () => ({ stdout: JSON.stringify({ results: [flat()], source_status: { reddit: 'partial', youtube: 'no-results' }, warnings: ['Coverage limited'] }), stderr: '' }),
    verifyImpl: async () => verified(), onProgress: (event) => events.push(event),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].publishable, true);
  assert.equal(result.counts.verified.curiosity, 1);
  assert.ok(events.some((event) => event.type === 'verification_finished' && event.publishable));
  assert.ok(result.warnings.some((warning) => warning.code === 'RESEARCH_COVERAGE_INCOMPLETE' && warning.source === 'reddit'));
  assert.ok(!result.warnings.some((warning) => warning.code === 'RESEARCH_COVERAGE_INCOMPLETE' && warning.source === 'youtube'));
});

test('editorial selection corrects query hints before factual verification and keeps discovery counts separate', async (t) => {
  const reviewed = [];
  const topics = ['Google AI chips in space', 'GitHub image parser bug', 'Peixe que regenera órgãos', 'Opinião sobre eleição'];
  const result = await research(t, {
    runImpl: async ({ args }) => ({ stdout: JSON.stringify({ results: args[0] === 'unusual animals' ? topics.map((title) => flat(title)) : [] }), stderr: '' }),
    selectImpl: async (items) => {
      assert.equal(items.length, 4);
      assert.ok(items.every((item) => item.category === 'curiosity'));
      const decisions = items.map((item, index) => ({ id: item.id, eligible: index === 0 || index === 2, category: index === 2 ? 'curiosity' : 'news', reason: index === 0 ? 'Inovação tecnológica concreta.' : index === 2 ? 'Biologia animal surpreendente.' : 'Fora da linha editorial.' }));
      // Even accidental adapter mutation cannot replace original research data.
      items[0].topic = 'Invented replacement';
      items[0].sources[0].url = 'https://invented.test';
      return decisions;
    },
    verifyImpl: async (item) => {
      reviewed.push(item);
      assert.equal(item.editorial.eligible, true);
      return verified([evidence(), evidence('https://news.test/report', { isPrimary: false })]);
    },
  });
  assert.deepEqual(reviewed.map((item) => item.topic).sort(), [topics[0], topics[2]].sort());
  assert.equal(reviewed.find((item) => item.topic === topics[0]).category, 'news');
  assert.ok(reviewed.every((item) => item.sources.every((source) => !source.url.includes('invented'))));
  assert.deepEqual(result.counts.discoveredByCategory, { curiosity: 4, news: 0 });
  assert.deepEqual(result.counts.editorial, { applied: true, reviewed: 4, eligible: 2, excluded: 2, failed: 0, eligibleByCategory: { curiosity: 1, news: 1 } });
  assert.deepEqual(result.counts.verified, { curiosity: 1, news: 1 });
  assert.equal(result.editorialDecisions.filter((item) => item.status === 'blocked').length, 2);
  assert.ok(!result.warnings.some((warning) => warning.code === 'CANDIDATES_TRUNCATED'));
});

test('editorial selection runs before fair limit so rejected topics do not crowd out eligible discoveries', async (t) => {
  const result = await research(t, {
    runImpl: async ({ args }) => ({ stdout: JSON.stringify({ results: args[0] === 'unusual animals' ? Array.from({ length: 52 }, (_, index) => flat(`Tema ${index}`)) : [] }), stderr: '' }),
    selectImpl: async (items) => {
      assert.equal(items.length, 52);
      return items.map((item, index) => ({ id: item.id, eligible: index >= 44, category: index < 48 ? 'curiosity' : 'news', reason: 'Avaliação editorial do tema.' }));
    },
    verifyImpl: async (item) => {
      assert.ok(Number(item.topic.split(' ')[1]) >= 44);
      return verified([evidence(), evidence('https://news.test/report', { isPrimary: false })]);
    },
  });
  assert.equal(result.counts.editorial.reviewed, 52);
  assert.equal(result.counts.editorial.excluded, 44);
  assert.equal(result.candidates.length, 8);
  assert.deepEqual(result.counts.verified, { curiosity: 4, news: 4 });
});

test('failed, malformed or invented editorial decisions block all candidates before the factual verifier', async (t) => {
  for (const selectImpl of [
    async () => { throw new Error('private model output'); },
    async () => [],
    async (items) => items.map((item) => ({ id: 'invented-' + item.id, eligible: true, category: 'news', reason: 'Invalid ID.' })),
    async (items) => items.map((item) => ({ id: item.id, eligible: true, category: 'news', reason: 'Too many fields.', sources: [] })),
  ]) {
    const result = await research(t, {
      runImpl: async () => ({ stdout: JSON.stringify({ results: [flat()] }), stderr: '' }), selectImpl,
      verifyImpl: async () => assert.fail('editorial failure must prevent verification'),
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.counts.editorial.failed, 1);
    assert.equal(result.counts.editorial.eligible, 0);
    assert.equal(result.editorialDecisions[0].status, 'blocked');
    assert.equal(result.editorialDecisions[0].eligible, false);
    assert.ok(result.warnings.some((warning) => warning.code.startsWith('EDITORIAL_SELECTION_')));
    assert.ok(!JSON.stringify(result).includes('private model output'));
  }
});
