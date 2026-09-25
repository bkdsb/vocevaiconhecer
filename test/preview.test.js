import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreview } from '../src/preview.js';
import { openDatabase, createStore } from '../src/db.js';
import { handleApprovalCommand, publishDue } from '../src/workflow.js';

const now = new Date('2026-09-25T13:00:00.000Z');
const sourceUrl = 'https://science.nasa.gov/example-research';
const clock = () => new Date(now);
const candidate = () => ({
  id: 'candidate_preview', topic: 'Como tardígrados resistem a condições extremas', category: 'curiosity',
  sources: [{ id: 'discovery', url: sourceUrl, title: 'Pesquisa original', publishedAt: '2021-09-01T00:00:00.000Z', text: 'Pesquisa antiga recuperada para demonstração.', metrics: {} }],
  trend: { hasRecentSignal: false }, publishable: false,
});
const primaryEvidence = (overrides = {}) => ({
  url: sourceUrl, title: 'Pesquisa original sobre tardígrados',
  text: 'Tardígrados foram estudados para compreender como esses animais respondem a condições extremas. O estudo descreve limites e mecanismos dessa resistência.',
  publishedAt: '2021-09-01T00:00:00.000Z', retrievedAt: now.toISOString(), retrievalMethod: 'web-fetch', verified: true,
  isPrimary: true, primaryReason: 'Relato original da instituição responsável pela pesquisa.', ...overrides,
});
const verified = (overrides = {}) => ({
  verdict: 'verified', explanation: 'A afirmação consta no texto recuperado da fonte primária.',
  sources: [primaryEvidence()], claims: [{ text: 'Tardígrados foram estudados quanto à resistência a condições extremas.', sourceUrls: [sourceUrl] }],
  ...overrides,
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vvc-preview-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { outputDir: join(directory, 'output'), dataDir: join(directory, 'data'), allowedSenders: ['+5511999999999'], metaPublishEnabled: true };
  const imageBuffer = await readFile(new URL('../assets/brand/logo.png', import.meta.url));
  const calls = { copy: [], image: [], render: [], send: [] };
  const copy = { headline: 'OS LIMITES DOS TARDÍGRADOS', highlights: ['TARDÍGRADOS'], caption: `Pesquisa explicada com suas limitações.\n\nImagem ilustrativa gerada por IA.\n\nFontes:\n${sourceUrl}`, imagePrompt: 'documentary macro photograph of a tardigrade', sourceIds: ['verified-source'], claims: [{ text: 'Afirmação apoiada pelo estudo.', sourceIds: ['verified-source'] }] };
  const generated = { buffer: imageBuffer, id: 'image-test', provider: 'openclaw-codex', model: 'openai/gpt-image-2', prompt: copy.imagePrompt, generatedAt: now.toISOString() };
  const ai = {
    generateCopy: async (value) => { calls.copy.push(value); return copy; },
    generateImage: async (value) => { calls.image.push(value); return generated; },
  };
  const renderer = async (value) => { calls.render.push(value); await writeFile(value.outputPath, value.imageBuffer); return { path: value.outputPath }; };
  const messenger = { send: async (value) => { calls.send.push(value); return { sent: true }; } };
  return { config, imageBuffer, copy, generated, calls, ai, renderer, messenger, args: { config, candidate: candidate(), ai, renderer, clock, verifyImpl: async () => verified() } };
}

test('an older verified curiosity without recent trend is a technical preview outside approval, storage and scheduling', async (t) => {
  const f = await fixture(t);
  const db = await openDatabase(f.config.dataDir);
  const store = createStore(db);
  t.after(() => store.close());
  const result = await createPreview(f.args);
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.match(result.id, /^preview_/);
  assert.equal(result.publishable, false);
  assert.equal(result.sent, false);
  assert.equal(report.kind, 'technical-preview');
  assert.equal(report.publishable, false);
  assert.deepEqual(report.candidate.blockedReasons, ['NO_RECENT_DATED_TREND_SIGNAL']);
  assert.equal(report.candidate.publishable, false);
  assert.equal(report.candidate.sources[0].publishedAt, '2021-09-01T00:00:00.000Z');
  assert.equal(report.candidate.sources[0].retrievedAt, now.toISOString());
  assert.equal(report.candidate.sources[0].isPrimary, true);
  assert.equal(report.createdAt, now.toISOString());
  assert.match(report.note, /fora dos lotes e sem agendamento/);
  for (const table of ['batches', 'posts', 'events']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  assert.equal(store.latestBatch(), null);
  assert.deepEqual(store.listReady(), []);
  await assert.rejects(handleApprovalCommand({ text: `APROVAR ${result.id} abcdef01`, sender: f.config.allowedSenders[0], config: f.config, store, now }), { code: 'POST_NOT_FOUND' });
  let published = false;
  await publishDue({ store, config: f.config, now, meta: { publishPhoto: async () => { published = true; } } });
  assert.equal(published, false);
  assert.equal(report.approvedAt, undefined);
  assert.equal(report.scheduledAt, undefined);
});

test('preview passes exact generated copy and raster to renderer and persists provenance without image bytes', async (t) => {
  const f = await fixture(t);
  const result = await createPreview(f.args);
  assert.equal(f.calls.copy.length, 1);
  assert.equal(f.calls.copy[0].verification.verdict, 'verified');
  assert.equal(f.calls.copy[0].sources[0].text, primaryEvidence().text);
  assert.deepEqual(f.calls.image, [{ prompt: f.copy.imagePrompt }]);
  assert.deepEqual(f.calls.render, [{ imageBuffer: f.imageBuffer, headline: f.copy.headline, highlights: f.copy.highlights, outputPath: result.imagePath }]);
  assert.deepEqual(await readFile(result.imagePath), f.imageBuffer);
  const rawReport = await readFile(result.reportPath, 'utf8');
  const report = JSON.parse(rawReport);
  const { buffer, ...expectedProvenance } = f.generated;
  assert.deepEqual(report.image, expectedProvenance);
  assert.equal(report.image.buffer, undefined);
  assert.doesNotMatch(rawReport, /"type":\s*"Buffer"/);
  assert.deepEqual(report.copy, f.copy);
  assert.equal(report.imagePath, result.imagePath);
  assert.equal((await stat(result.reportPath)).mode & 0o777, 0o600);
  await assert.rejects(access(f.config.dataDir), { code: 'ENOENT' });
});

test('unsupported evidence blocks all copy, image, renderer, delivery and output creation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createPreview({ ...f.args, messenger: f.messenger, verifyImpl: async () => ({ verdict: 'unsupported', explanation: 'A fonte não apoia a afirmação.', sources: [], claims: [] }) }), { code: 'PREVIEW_UNVERIFIED' });
  assert.deepEqual(f.calls, { copy: [], image: [], render: [], send: [] });
  await assert.rejects(access(f.config.outputDir), { code: 'ENOENT' });
  await assert.rejects(access(f.config.dataDir), { code: 'ENOENT' });
});

test('recent news with a single verified source remains blocked even for a technical preview', async (t) => {
  const f = await fixture(t);
  const recent = '2026-09-24T09:00:00.000Z';
  const news = { ...candidate(), category: 'news', sources: [{ ...candidate().sources[0], publishedAt: recent, metrics: { comments: 30 } }] };
  await assert.rejects(createPreview({ ...f.args, candidate: news, messenger: f.messenger, verifyImpl: async () => verified({ sources: [primaryEvidence({ publishedAt: recent })] }) }), (error) => {
    assert.equal(error.code, 'PREVIEW_UNVERIFIED');
    assert.match(error.message, /NEWS_NEEDS_TWO_INDEPENDENT_DOMAINS/);
    return true;
  });
  assert.deepEqual(f.calls, { copy: [], image: [], render: [], send: [] });
  await assert.rejects(access(f.config.outputDir), { code: 'ENOENT' });
});

test('optional preview delivery contains the exact image, caption and technical notice without an approval command', async (t) => {
  const f = await fixture(t);
  const result = await createPreview({ ...f.args, messenger: f.messenger });
  assert.equal(result.sent, true);
  assert.equal(f.calls.send.length, 1);
  const message = f.calls.send[0];
  assert.equal(message.imagePath, result.imagePath);
  assert.match(message.text, /^PRÉVIA TÉCNICA — NÃO AGENDADA\n/);
  assert.ok(message.text.includes(f.copy.headline));
  assert.ok(message.text.includes(f.copy.caption));
  assert.match(message.text, /tendência não confirmada: sem sinal recente datado/);
  assert.match(message.text, /não entra no lote diário e não tem comando de aprovação/);
  assert.doesNotMatch(message.text, /APROVAR |REJEITAR /);
});
