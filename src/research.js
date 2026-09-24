import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const NEWS_WORDS = /\b(ai|ia|tecnologia|tech|medicina|médic|ciência|cient|pesquisa|descoberta|inov|robô|robot|computador|saúde|space|espaço|nasa|astronom|vacina|tratamento|chip|neural|quantum|energia)\b/iu;
const URL_RE = /^https?:\/\/[^\s]+$/i;

function idFor(topic, url = '') { return createHash('sha256').update(`${topic}\0${url}`).digest('hex').slice(0, 20); }
function dateValue(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
function within(date, now, days) { const parsed = dateValue(date); return parsed && parsed <= now && (now - parsed) <= days * 86_400_000; }
function cleanUrl(value) { return typeof value === 'string' && URL_RE.test(value) ? value : ''; }
function sourceFrom(url, index, result, now, days) {
  const parsed = dateValue(result?.published_at);
  return { id: idFor(String(result?.title || result?.topic || result?.name || 'evidence'), url || String(index)), url, title: String(result?.title || result?.topic || result?.name || 'Fonte de tendência'), publishedAt: parsed?.toISOString() || null, text: String(result?.summary || result?.why_spiking || '').slice(0, 2_000), isPrimary: false };
}

function normalizeReport(report, now, days) {
  // `last30days --discover --json-profile=raw` currently calls its ranked
  // discovery rows `topics`; older profiles used `results`/`findings`.
  const ranked = Array.isArray(report?.ranked_candidates) ? report.ranked_candidates.map((item) => ({
    topic: item.title,
    why_spiking: item.snippet || item.explanation,
    velocity_score: item.final_score,
    corroboration_count: Array.isArray(item.sources) ? item.sources.length : 0,
    evidence_urls: [item.url, ...(Array.isArray(item.source_items) ? item.source_items.map((source) => source.url) : [])],
    engagement: { total: item.engagement },
    published_at: item.source_items?.[0]?.published_at,
    source: item.source,
    categoryHint: report?.categoryHint,
  })) : [];
  const results = Array.isArray(report?.results) ? report.results
    : Array.isArray(report?.findings) ? report.findings
      : Array.isArray(report?.topics) ? report.topics : ranked;
  const discovery = report?.kind === 'discovery' || Array.isArray(report?.topics) || Array.isArray(report?.ranked_candidates) || Array.isArray(report?.results) && report?.velocity_score === undefined;
  const entries = discovery ? results : results.map((item) => ({ ...item, topic: item.title, why_spiking: item.summary }));
  const candidates = [];
  for (const result of entries) {
    const topic = String(result.topic || result.title || result.name || '').replace(/\s+/gu, ' ').trim();
    if (!topic) continue;
    const urls = [...new Set((Array.isArray(result.evidence_urls) ? result.evidence_urls : [result.url]).map(cleanUrl).filter(Boolean))];
    const sources = urls.map((url, index) => sourceFrom(url, index, result, now, days));
    const published = dateValue(result.published_at);
    const recentSources = sources.filter((source) => !source.publishedAt || within(source.publishedAt, now, days));
    const signals = [];
    for (const source of sources) {
      const native = result.engagement || result.engagement_by_source || {};
      const values = Object.values(native).flatMap((value) => value && typeof value === 'object' ? Object.values(value) : [value])
        .filter((value) => Number.isFinite(Number(value))).map(Number);
      if (values.length) signals.push({ url: source.url, source: result.source || (result.sources?.[0] || 'trend'), publishedAt: source.publishedAt, engagement: Math.max(...values) });
    }
    const isNews = result.categoryHint === 'news' ? true : result.categoryHint === 'curiosity' ? false
      : NEWS_WORDS.test(`${topic} ${String(result.why_spiking || '')}`) || /update|announce|research|study|launch|discover/i.test(String(result.why_spiking || '').replace(/hackernews|reddit|evidence items/gi, ''));
    const category = isNews ? 'news' : 'curiosity';
    const corroboration = Number(result.corroboration_count || result.sources?.length || sources.length || 0);
    const score = Number.isFinite(Number(result.velocity_score)) ? Number(result.velocity_score) : Number.isFinite(Number(result.relevance_score)) ? Math.round(Number(result.relevance_score) * 100) : null;
    const trend = { score: score === null ? null : Math.max(0, Math.min(100, score)), label: score === null ? 'sem métrica de engajamento disponível' : score >= 75 ? 'forte sinal de tendência' : score >= 45 ? 'sinal de tendência' : 'sinal fraco', signals };
    const enoughNews = category !== 'news' || (sources.length >= 2 && corroboration >= 2 && (recentSources.length >= 1 || !published));
    const enoughCuriosity = category !== 'curiosity' || sources.length >= 1;
    if (!enoughNews || !enoughCuriosity) continue;
    candidates.push({ id: idFor(topic, urls[0]), topic, category, summary: String(result.why_spiking || result.summary || '').slice(0, 1_500), sources, trend, evidenceStatus: 'ready', publishable: true, raw: { source: result.source || null, momentum: result.momentum || null, corroboration } });
  }
  const seen = new Set();
  return candidates.filter((candidate) => { const key = candidate.topic.toLocaleLowerCase('pt-BR'); if (seen.has(key)) return false; seen.add(key); return true; });
}

export function runLast30Days({ pythonBin, scriptPath, args, timeoutMs = 300_000, env = {}, spawnImpl = spawn } = {}) {
  if (!pythonBin || !scriptPath || !Array.isArray(args)) return Promise.reject(new TypeError('Configuração last30days incompleta.'));
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(pythonBin, [scriptPath, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.(); }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; if (stdout.length > 10_000_000) child.kill('SIGTERM'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(Object.assign(new Error('last30days não pôde ser iniciado.'), { code: 'RESEARCH_UNAVAILABLE', cause: error })); });
    child.once('close', (code) => { clearTimeout(timer); if (killed) return reject(Object.assign(new Error('Pesquisa excedeu o tempo limite.'), { code: 'RESEARCH_TIMEOUT', stderr: stderr.slice(-2_000) })); if (code !== 0) return reject(Object.assign(new Error('last30days retornou erro.'), { code: 'RESEARCH_FAILED', exitCode: code, stderr: stderr.slice(-4_000) })); resolvePromise({ stdout, stderr }); });
  });
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  try { return JSON.parse(trimmed); } catch {
    const start = Math.min(...['{', '['].map((mark) => { const i = trimmed.indexOf(mark); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
    if (start !== Number.MAX_SAFE_INTEGER) { try { return JSON.parse(trimmed.slice(start)); } catch { /* continue */ } }
  }
  throw Object.assign(new Error('A saída JSON do last30days é inválida.'), { code: 'RESEARCH_INVALID_RESPONSE' });
}

export async function researchTopics(config, { now = new Date(), onProgress = () => {}, runImpl = runLast30Days } = {}) {
  await mkdir(config.last30daysDir, { recursive: true });
  const scriptPath = resolve(config.last30daysDir, 'vendor/last30days/skills/last30days/scripts/last30days.py');
  const env = { LAST30DAYS_MEMORY_DIR: config.last30daysDir, LAST30DAYS_CONFIG_DIR: resolve(config.last30daysDir, 'config'), SKIP_KEYCHAIN: '1', FROM_BROWSER: 'off', AUTH_TOKEN: '', CT0: '', X_BEARER_TOKEN: '', XAI_API_KEY: '', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', PERPLEXITY_API_KEY: '' };
  const warnings = [];
  const run = async (args) => { onProgress({ type: 'research_started', args }); const result = await runImpl({ pythonBin: config.pythonBin, scriptPath, args, timeoutMs: config.researchTimeoutMs, env }); onProgress({ type: 'research_finished' }); return parseJsonOutput(result.stdout); };
  const jobs = [
    { label: 'global', args: ['--discover', '--emit=json', '--json-profile=raw', '--days=15', '--no-browser-cookies', '--save-dir', config.last30daysDir] },
    ...['unusual animals', 'strange foods', 'space mysteries', 'unusual countries traditions'].map((topic) => ({ label: `curiosity:${topic}`, categoryHint: 'curiosity', args: [topic, '--emit=json', '--json-profile=raw', '--days=15', '--no-browser-cookies', '--save-dir', config.last30daysDir] })),
    ...['science medicine breakthrough', 'AI technology innovation'].map((topic) => ({ label: `news:${topic}`, categoryHint: 'news', args: [topic, '--emit=json', '--json-profile=raw', '--days=15', '--no-browser-cookies', '--save-dir', config.last30daysDir] })),
  ];
  const completed = await Promise.allSettled(jobs.map(async (job) => ({ job, report: await run(job.args) })));
  const reports = [];
  for (const result of completed) {
    if (result.status === 'fulfilled') reports.push({ ...result.value.report, categoryHint: result.value.job.categoryHint });
    else warnings.push({ code: result.reason?.code || 'RESEARCH_FAILED', message: result.reason?.message || 'Pesquisa indisponível.' });
  }
  const candidates = reports.flatMap((report) => normalizeReport(report, now, 15));
  const counts = { curiosity: 0, news: 0 }; for (const candidate of candidates) counts[candidate.category] += 1;
  if (counts.curiosity < 4) warnings.push({ code: 'INSUFFICIENT_CURIOSITIES', available: counts.curiosity, requested: 4 });
  if (counts.news < 4) warnings.push({ code: 'INSUFFICIENT_NEWS', available: counts.news, requested: 4 });
  return { candidates: candidates.slice(0, 40), coverage: reports.map((report) => report.source_status || report.feeds || {}), warnings, generatedAt: now.toISOString(), windowDays: 15 };
}

export { normalizeReport };
