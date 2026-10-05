import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rmdir, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { freshEnoughForPublication } from './freshness.js';

const VERSION = 1;
const ID = /^[a-f0-9]{8}$/u;
const METRICS = ['likes', 'comments', 'shares', 'views', 'num_comments', 'score', 'points', 'reactions', 'upvotes'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : '';
function safeURL(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return '';
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    for (const key of [...url.searchParams.keys()]) if (/token|secret|key|signature|authorization/iu.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return ''; }
}
function planDir(config) {
  if (!config?.dataDir) fail('TOPIC_PLAN_CONFIG_INVALID', 'O diretório de dados das pautas não foi configurado.');
  return resolve(config.dataDir, 'topic-plans');
}
function planPath(config, id) {
  if (!ID.test(id || '')) {
    fail('TOPIC_PLAN_ID_INVALID', `Código de pauta inválido: "${id}".`);
  }
  return join(planDir(config), `${id}.json`);
}
function realMetrics(source, engine) {
  if (source?.provenance?.kind === 'profile-post') return {};
  return Object.fromEntries(METRICS.flatMap((key) => {
    const value = source?.metrics?.[key];
    // Scrapling's synthetic score is not a native Facebook counter.
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !(key === 'score' && engine === 'scrapling') ? [[key, value]] : [];
  }));
}
function baseSource(candidate) {
  return (candidate.sources || []).find((source) => isFacebookBasedCandidate({ raw: candidate.raw, sources: [source] }))
    || (candidate.sources || []).find((source) => source.provenance?.engine === 'scrapling') || candidate.sources?.[0];
}
export function isFacebookBasedCandidate(candidate) {
  return (candidate?.sources || []).some((source) => {
    let host;
    try { host = new URL(source.url).hostname.toLowerCase(); } catch { return false; }
    const facebookURL = host === 'facebook.com' || host.endsWith('.facebook.com');
    const collectedPost = source.provenance?.engine === 'scrapling' && ['source-item', 'profile-post'].includes(source.provenance?.kind);
    return facebookURL && Boolean(text(source.text, 6000)) && (candidate.raw?.inspirationKind === 'facebook' || collectedPost);
  });
}
function assertFacebookPlan(plan, config) {
  if (plan.status === 'superseded') fail('TOPIC_PLAN_SUPERSEDED', 'Essa seleção foi substituída porque não respeitava a base obrigatória nas páginas do Facebook. Solicite uma nova pesquisa.');
  if ((config?.facebookBaseRequired === true || plan.facebookBaseRequired === true) && plan.items.some((item) => !isFacebookBasedCandidate(item.candidate))) fail('TOPIC_PLAN_FACEBOOK_BASE_REQUIRED', 'Todos os temas devem partir de posts das páginas de referência do Facebook. Solicite uma nova pesquisa.');
}
export function topicPlanScore(candidate) {
  const source = baseSource(candidate);
  const counters = realMetrics(source, source?.provenance?.engine || candidate.raw?.engine);
  const count = (keys) => { const key = keys.find((name) => Object.hasOwn(counters, name)); return key ? counters[key] : 0; };
  // Match Facebook discovery ranking, then normalize for display. No aggregate
  // counters or relevance values are presented as measured virality.
  const raw = Math.log1p(count(['likes', 'reactions', 'upvotes', 'points', 'score'])) + 2 * Math.log1p(count(['comments', 'num_comments'])) + Math.log1p(count(['shares'])) + 0.5 * Math.log1p(count(['views']));
  const known = Object.keys(counters);
  return { value: Math.round(raw * 100) / 100, formula: 'ln(1+curtidas/reacoes/pontos) + 2*ln(1+comentarios) + ln(1+compartilhamentos) + 0.5*ln(1+visualizacoes)', available: known.length > 0,
    partial: known.length > 0 && ![['likes', 'reactions', 'upvotes', 'points', 'score'], ['comments', 'num_comments'], ['shares'], ['views']].every((keys) => keys.some((key) => Object.hasOwn(counters, key))) };
}
function snapshot(candidate) {
  const sources = (Array.isArray(candidate?.sources) ? candidate.sources : []).slice(0, 16).flatMap((source) => {
    const url = safeURL(source?.url);
    const id = text(source?.id, 128);
    if (!url || !id) return [];
    const engine = source.provenance?.engine || candidate.raw?.engine;
    return [{ id, url, title: text(source.title), source: text(source.source, 120), text: text(source.text, 6000), publishedAt: source.publishedAt || null,
      metrics: realMetrics(source, engine), isPrimary: source.isPrimary === true,
      provenance: { engine: text(engine, 64), kind: text(source.provenance?.kind, 64) } }];
  });
  return { id: text(candidate?.id, 128), topic: text(candidate?.topic), summary: text(candidate?.summary, 2000), category: candidate?.category,
    sources, publishable: candidate?.publishable === true, evidenceStatus: text(candidate?.evidenceStatus, 40), blockedReasons: [],
    trend: { rankingScore: Number.isFinite(candidate?.trend?.rankingScore) ? candidate.trend.rankingScore : null },
    raw: { engine: text(candidate?.raw?.engine, 64), inspirationKind: text(candidate?.raw?.inspirationKind, 32), inspirationSource: text(candidate?.raw?.inspirationSource, 120), inspirationUrl: safeURL(candidate?.raw?.inspirationUrl), searches: [] } };
}
function memoryDuplicate(candidate, memories) {
  const normalize = (value) => text(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = (value) => new Set(normalize(value).split(' ').filter((word) => word.length > 3));
  const topicWords = words(candidate.topic);
  const urls = new Set(candidate.sources.filter((source) => source.provenance?.kind !== 'profile-post').map((source) => safeURL(source.url)));
  return memories.some((memory) => {
    if (normalize(memory.topic) === normalize(candidate.topic)) return true;
    if ((memory.sources || []).some((source) => source.provenance?.kind !== 'profile-post' && urls.has(safeURL(source.url)))) return true;
    const previous = words(memory.topic);
    if (!previous.size || !topicWords.size) return false;
    const shared = [...topicWords].filter((word) => previous.has(word)).length;
    return shared / Math.min(previous.size, topicWords.size) >= 0.8;
  });
}
async function save(config, plan) {
  const dir = planDir(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = planPath(config, plan.id);
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(plan, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
async function locked(config, id, action) {
  const lock = `${planPath(config, id)}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= 30) {
        try { if (Date.now() - (await stat(lock)).mtimeMs > 15000) { await rmdir(lock).catch(() => {}); continue; } } catch {}
        fail('TOPIC_PLAN_BUSY', 'A pauta está sendo atualizada; tente novamente em instantes.');
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  try { return await action(); } finally { await rmdir(lock).catch(() => {}); }
}
export async function createTopicPlan({ config, store, researchResult, result = researchResult, now = new Date(), targetDay, repeatsImpl = memoryDuplicate } = {}) {
  const day = targetDay || new Intl.DateTimeFormat('en-CA', { timeZone: config?.timezone || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail('TOPIC_PLAN_DAY_INVALID', 'Data das pautas inválida.');
  const memories = store?.topicMemory?.() || [];
  const seen = new Set();
  const available = (Array.isArray(result?.candidates) ? result.candidates : []).map(snapshot).filter((candidate) => {
    const unique = !seen.has(candidate.id) && !seen.has(candidate.topic.toLowerCase());
    if (!candidate.id || !candidate.topic || !candidate.sources.length || !candidate.publishable || !['curiosity', 'news'].includes(candidate.category) || !freshEnoughForPublication(candidate, now) || repeatsImpl(candidate, memories, now) || !unique
      || config.facebookBaseRequired === true && !isFacebookBasedCandidate(candidate)) return false;
    seen.add(candidate.id); seen.add(candidate.topic.toLowerCase()); return true;
  });
  const selected = ['curiosity', 'news'].flatMap((category) => available.filter((candidate) => candidate.category === category)
    .sort((a, b) => Number(b.raw.inspirationKind === 'facebook') - Number(a.raw.inspirationKind === 'facebook') || topicPlanScore(b).value - topicPlanScore(a).value || a.id.localeCompare(b.id)).slice(0, 4));
  if (!selected.length) fail('TOPIC_PLAN_EMPTY', config.facebookBaseRequired === true
    ? 'A pesquisa não encontrou posts disponíveis das páginas de referência do Facebook. As fontes complementares não podem substituir essa base.'
    : 'A pesquisa não encontrou pautas disponíveis, atuais e ainda não usadas.');
  const plan = { version: VERSION, id: randomBytes(4).toString('hex'), createdAt: now.toISOString(), updatedAt: now.toISOString(), targetDay: day, status: 'pending', approvedIndices: [], facebookBaseRequired: config.facebookBaseRequired === true,
    items: selected.map((candidate, index) => ({ index: index + 1, candidate, score: topicPlanScore(candidate),
      metricsAvailable: Object.keys(baseSource(candidate).metrics),
      baseURL: baseSource(candidate).url, source: baseSource(candidate).source, publishedAt: baseSource(candidate).publishedAt })),
    remaining: { curiosity: 4 - selected.filter((candidate) => candidate.category === 'curiosity').length, news: 4 - selected.filter((candidate) => candidate.category === 'news').length } };
  await save(config, plan);
  return plan;
}
export async function loadTopicPlan({ config, id } = {}) {
  if (!id || id === 'LATEST') {
    const plans = await listTopicPlans({ config });
    const active = plans.find(p => ['pending', 'approved'].includes(p.status));
    if (!active) fail('TOPIC_PLAN_NOT_FOUND', 'Não há pautas aguardando.');
    id = active.id;
  }
  let plan;
  try { plan = JSON.parse(await readFile(planPath(config, id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') fail('TOPIC_PLAN_NOT_FOUND', 'Não encontrei esse código de pautas.'); if (error instanceof SyntaxError) fail('TOPIC_PLAN_INVALID', 'O arquivo de pautas está inválido.'); throw error; }
  if (plan?.version !== VERSION || plan.id !== id || !['pending', 'approved', 'consumed', 'superseded'].includes(plan.status) || !Array.isArray(plan.items) || plan.items.length > 8 || !Array.isArray(plan.approvedIndices)) fail('TOPIC_PLAN_INVALID', 'O arquivo de pautas está inválido.');
  return plan;
}
export const readTopicPlan = loadTopicPlan;
export async function listTopicPlans({ config } = {}) {
  let files;
  try { files = await readdir(planDir(config)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const plans = await Promise.all(files.filter((name) => /^[a-f0-9]{8}\.json$/u.test(name)).map((name) => loadTopicPlan({ config, id: name.slice(0, 8) })));
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function approveTopicPlan({ config, id, indices, all = false, selection = indices, now = new Date() } = {}) {
  const initial = await loadTopicPlan({ config, id });
  const realId = initial.id;
  return locked(config, realId, async () => {
    const plan = await loadTopicPlan({ config, id: realId });
    assertFacebookPlan(plan, config);
    const selected = all || typeof selection === 'string' && /^(all|todos|todas)$/iu.test(selection.trim()) ? plan.items.map((item) => item.index)
      : typeof selection === 'string' ? selection.split(/[\s,;]+/u).filter(Boolean).map(Number) : selection;
    if (!Array.isArray(selected) || !selected.length || selected.some((index) => !Number.isInteger(index) || !plan.items.some((item) => item.index === index))) fail('TOPIC_PLAN_SELECTION_INVALID', 'Selecione números de pautas existentes ou aprove todas.');
    if (plan.status === 'consumed') {
      if (selected.some((index) => !plan.approvedIndices.includes(index))) fail('TOPIC_PLAN_CONSUMED', 'Essa geração já terminou. Solicite uma nova pesquisa para gerar outros temas.');
      return plan;
    }
    if (selected.some((index) => !freshEnoughForPublication(plan.items.find((item) => item.index === index).candidate, now))) fail('TOPIC_PLAN_EXPIRED', 'Uma pauta urgente passou de 24 horas ou perdeu a validade. Preciso pesquisar novamente antes de gerar sua imagem.');
    plan.approvedIndices = [...new Set([...plan.approvedIndices, ...selected])].sort((a, b) => a - b);
    plan.status = 'approved'; plan.updatedAt = now.toISOString();
    await save(config, plan); return plan;
  });
}
export function researchForApprovedPlan(plan, { now = new Date(), config } = {}) {
  if (plan) assertFacebookPlan(plan, config);
  if (plan?.status !== 'approved' || !Array.isArray(plan.approvedIndices) || !plan.approvedIndices.length) fail('TOPIC_PLAN_APPROVAL_REQUIRED', 'Aprove as pautas antes da geração de imagens.');
  const approved = plan.items.filter((item) => plan.approvedIndices.includes(item.index));
  const candidates = approved.map((item) => structuredClone(item.candidate)).filter((candidate) => candidate.publishable && freshEnoughForPublication(candidate, now));
  if (!candidates.length) fail('TOPIC_PLAN_EXPIRED', 'As pautas aprovadas perderam a validade. É necessário pesquisar novamente.');
  return { candidates, inspirationProfiles: [], generatedAt: now.toISOString(), engine: 'approved-topic-plan', topicPlanId: plan.id,
    warnings: candidates.length < approved.length ? [{ code: 'TOPIC_PLAN_PARTIALLY_EXPIRED', expired: approved.length - candidates.length }] : [] };
}
export async function markTopicPlanConsumed({ config, id, now = new Date() } = {}) {
  await loadTopicPlan({ config, id });
  return locked(config, id, async () => {
    const plan = await loadTopicPlan({ config, id });
    assertFacebookPlan(plan, config);
    if (plan.status === 'pending') fail('TOPIC_PLAN_APPROVAL_REQUIRED', 'A pauta ainda aguarda aprovação.');
    plan.status = 'consumed'; plan.updatedAt = now.toISOString(); await save(config, plan); return plan;
  });
}
export async function invalidateNonFacebookPlans(options = {}) {
  const config = options.config || options;
  const now = options.now || new Date();
  const invalidated = [];
  if (config.facebookBaseRequired !== true) return { invalidated, count: 0 };
  for (const existing of await listTopicPlans({ config })) {
    if (!['pending', 'approved'].includes(existing.status) || existing.items.every((item) => isFacebookBasedCandidate(item.candidate))) continue;
    await locked(config, existing.id, async () => {
      const plan = await loadTopicPlan({ config, id: existing.id });
      if (!['pending', 'approved'].includes(plan.status) || plan.items.every((item) => isFacebookBasedCandidate(item.candidate))) return;
      plan.status = 'superseded';
      plan.updatedAt = now.toISOString();
      plan.supersededReason = 'FACEBOOK_BASE_REQUIRED';
      await save(config, plan);
      invalidated.push(plan.id);
    });
  }
  return { invalidated, count: invalidated.length };
}
export function formatTopicPlanMessages(plan) {
  const blocks = [`📋 *Pautas para ${plan.targetDay}* (Cód: ${plan.id})\nEscolha os temas para gerar as imagens.\n${plan.facebookBaseRequired ? '_Fontes baseadas no Facebook_\n' : ''}_(O Score ajuda a priorizar, mas não é garantia de viralização)_`];
  for (const { index, candidate, score } of plan.items) {
    const source = baseSource(candidate);
    const metrics = source.metrics || {};
    const count = (names) => { const key = names.find((name) => Object.hasOwn(metrics, name)); return key ? metrics[key].toLocaleString('pt-BR') : 'indisponível'; };
    blocks.push(`*${index}.* ${candidate.topic}\n` +
`🔸 *${candidate.category === 'news' ? 'Notícia' : 'Curiosidade'}* | Score: ${score.available ? `${score.value.toFixed(2)}${score.partial ? ' (parcial)' : ''}` : 'indisponível'}\n` +
`📍 *Fonte:* ${text(source.source || source.title, 80)}\n` +
`👍 *Curtidas:* ${count(['likes', 'reactions'])} | 💬 *Comentários:* ${count(['comments', 'num_comments'])}\n` +
`🔗 *Base:* ${source.provenance?.kind === 'profile-post' ? '(página - link do post indisponível) ' : ''}${source.url}`);
  }
  if (plan.remaining?.curiosity || plan.remaining?.news) blocks.push(`ℹ️ Faltam ${plan.remaining.curiosity} curiosidades e ${plan.remaining.news} notícias para fechar as 8 pautas.`);
  blocks.push(`✅ *Como aprovar?*\nPara todos: *APROVAR TEMAS TODOS*\nPara alguns: *APROVAR TEMAS 1,2* (números desejados)`);
  const messages = [];
  let current = '';
  for (const block of blocks) {
    // URLs are bounded on input in normal research; split oversized external
    // data rather than produce an undeliverable WhatsApp message.
    for (let offset = 0; offset < block.length; offset += 3400) {
      const part = block.slice(offset, offset + 3400);
      if (current && current.length + part.length + 2 > 3500) { messages.push(current); current = ''; }
      current += `${current ? '\n\n' : ''}${part}`;
    }
  }
  if (current) messages.push(current);
  return messages;
}
