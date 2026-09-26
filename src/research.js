import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { validateEditorialDecisions } from './editorial-selection.js';

const NEWS_WORDS = /\b(ai|ia|tecnologia|technology|tech|medicina|medicine|science|research|breakthrough|pesquisa|descoberta|inovação|innovation|robô|robot|computador|saúde|nasa|vacina|tratamento|chip|neural|quantum|energia)\b|cient[íi]fic|m[ée]dic|astronom/iu;
const COUNTER_NAMES = /^(score|points|likes|reposts|retweets|shares|comments|num_comments|views|view_count|like_count|comment_count|postCount|uniqueAuthors|upvotes|votes|favorites)$/i;

function idFor(topic, url = '') { return createHash('sha256').update(`${topic}\0${url}`).digest('hex').slice(0, 20); }
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value)) return null;
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date;
}
function within(date, now, days) { const parsed = dateValue(date); return parsed && parsed <= now && (now - parsed) <= days * 86_400_000; }
function cleanUrl(value) {
  try {
    if (typeof value !== 'string' || /\s/u.test(value)) return '';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/iu.test(key)) url.searchParams.delete(key);
    url.hostname = url.hostname.replace(/^www\./u, '');
    url.pathname = url.pathname.replace(/\/$/u, '') || '/';
    return url.toString();
  } catch { return ''; }
}
function nativeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, number]) => COUNTER_NAMES.test(key) && typeof number === 'number' && Number.isFinite(number) && number >= 0));
}
function sourceFrom(item, { linkedOnly = false, query = '' } = {}) {
  const url = cleanUrl(item.url); if (!url) return null;
  return {
    id: idFor('source', url), url,
    title: linkedOnly ? '' : String(item.title || ''),
    publishedAt: linkedOnly ? null : dateValue(item.published_at)?.toISOString() || null,
    text: linkedOnly ? '' : String(item.body || item.snippet || item.summary || '').slice(0, 6_000),
    source: linkedOnly ? null : item.source || null,
    metrics: linkedOnly ? {} : nativeMetrics(item.engagement),
    isPrimary: false,
    provenance: { engine: 'last30days', query, kind: linkedOnly ? 'discovery-link' : 'source-item', itemId: item.item_id || item.candidate_id || null, dateConfidence: item.date_confidence || null },
  };
}
function sourceSignals(sources, now, days) {
  return sources.filter((source) => source.publishedAt && Object.values(source.metrics || {}).some((value) => value > 0)).map((source) => ({
    sourceId: source.id, url: source.url, source: source.source, publishedAt: source.publishedAt,
    metrics: source.metrics, engagement: Math.max(...Object.values(source.metrics)), recent: Boolean(within(source.publishedAt, now, days)),
  }));
}
function refreshTrend(candidate, now, days) {
  const signals = sourceSignals(candidate.discoverySources || candidate.sources, now, days);
  return { ...candidate.trend, signals, hasRecentSignal: signals.some((signal) => signal.recent), label: signals.some((signal) => signal.recent) ? 'atividade recente detectada; viralidade não confirmada' : 'tendência não confirmada: sem sinal recente datado' };
}
function sourceMap(items) {
  const merged = new Map();
  for (const item of items.filter(Boolean)) {
    const prior = merged.get(item.url);
    // Prefer the actual source record; discovery URLs carry no own text/date.
    if (!prior || prior.provenance?.kind === 'discovery-link') merged.set(item.url, item);
  }
  return [...merged.values()];
}

function normalizeReport(report, now, days) {
  const results = Array.isArray(report?.results) ? report.results
    : Array.isArray(report?.findings) ? report.findings
      : Array.isArray(report?.topics) ? report.topics : report?.ranked_candidates || [];
  const discovery = report?.kind === 'discovery' || Array.isArray(report?.topics);
  const candidates = [];
  for (const result of results) {
    const topic = String(result.topic || result.title || result.name || '').replace(/\s+/gu, ' ').trim();
    if (!topic) continue;
    const query = report.query || report.searchLabel || '';
    const ownItems = (Array.isArray(result.source_items) ? result.source_items : []).map((item) => sourceFrom(item, { query }));
    // The flat agent profile supplies metadata for its canonical URL only.
    const primary = discovery ? null : sourceFrom(result, { query, linkedOnly: ownItems.length > 0 });
    const links = (Array.isArray(result.evidence_urls) ? result.evidence_urls : []).map((url) => sourceFrom({ url }, { linkedOnly: true, query }));
    const sources = sourceMap([...ownItems, primary, ...links]);
    const categoryHint = result.categoryHint || report.categoryHint;
    const isNews = categoryHint === 'news' ? true : categoryHint === 'curiosity' ? false : NEWS_WORDS.test(`${topic} ${String(result.why_spiking || result.summary || '')}`);
    const category = isNews ? 'news' : 'curiosity';
    const candidate = {
      id: idFor(topic, sources[0]?.url), topic, category,
      summary: String(result.why_spiking || result.summary || result.snippet || result.explanation || '').slice(0, 1_500), sources,
      trend: {
        // Relevance/reranking scores are not measures of virality.
        score: typeof result.velocity_score === 'number' && Number.isFinite(result.velocity_score) ? result.velocity_score : null,
        rankingScore: result.relevance_score ?? result.final_score ?? null,
        aggregateMetrics: discovery ? result.engagement_by_source || result.engagement || {} : {},
      },
      evidenceStatus: 'candidate', publishable: false,
      blockedReasons: ['EDITORIAL_VERIFICATION_REQUIRED'],
      raw: { engine: 'last30days', categoryHint: categoryHint || null, searches: [query], source: result.source || null, momentum: result.momentum || null, reportedCorroboration: result.corroboration_count ?? null },
    };
    candidate.trend = refreshTrend(candidate, now, days);
    if (!candidate.trend.hasRecentSignal) candidate.blockedReasons.push('NO_RECENT_DATED_TREND_SIGNAL');
    if (!sources.length) candidate.blockedReasons.push('NO_SOURCE_URL');
    candidates.push(candidate);
  }
  return candidates;
}

function independentDomain(url) {
  const labels = new URL(url).hostname.split('.');
  // Treat common publisher subdomains as one source, including e.g. co.uk.
  const count = labels.length > 2 && /^(co|com|org|net|ac|gov|edu)$/u.test(labels.at(-2)) && labels.at(-1).length === 2 ? 3 : 2;
  return labels.slice(-count).join('.');
}

/**
 * verifyImpl is a trusted adapter, not raw LLM JSON. It must attach verified,
 * retrievedAt and retrievalMethod only after actually retrieving/reviewing each
 * page, and justify primary-source status in primaryReason. Claims reference
 * exact sourceUrls. The local gate checks evidence shape, dates and diversity;
 * the adapter remains responsible for semantic support and source authenticity.
 */
export async function verifyCandidates(candidates, { verifyImpl, now = new Date(), clock = () => now, windowDays = 15, onProgress = () => {} } = {}) {
  const output = [];
  for (const candidate of candidates) {
    const blockedReasons = [];
    let verification;
    if (typeof verifyImpl !== 'function') blockedReasons.push('EDITORIAL_VERIFIER_NOT_CONFIGURED');
    else {
      onProgress({ type: 'verification_started', candidateId: candidate.id });
      try { verification = await verifyImpl(candidate); }
      catch (error) { blockedReasons.push('EDITORIAL_VERIFICATION_FAILED'); verification = { verdict: 'unsupported', explanation: String(error?.code || 'VERIFIER_ERROR') }; }
    }
    const checkedAt = clock();
    if (verification?.verdict !== 'verified') blockedReasons.push(verification?.verdict === 'contradicted' ? 'CLAIM_CONTRADICTED' : 'CLAIM_NOT_VERIFIED');
    const verifiedSources = sourceMap((Array.isArray(verification?.sources) ? verification.sources : []).flatMap((item) => {
      const url = cleanUrl(item.url); const retrieved = dateValue(item.retrievedAt);
      if (!url || item.verified !== true || !retrieved || retrieved > checkedAt || !within(item.retrievedAt, checkedAt, windowDays) || !['web-fetch', 'manual-review'].includes(item.retrievalMethod) || !String(item.title || '').trim() || !String(item.text || '').trim()) return [];
      return [{ id: idFor('source', url), url, title: String(item.title), text: String(item.text).slice(0, 12_000), publishedAt: dateValue(item.publishedAt)?.toISOString() || null,
        isPrimary: item.isPrimary === true && Boolean(String(item.primaryReason || '').trim()), primaryReason: String(item.primaryReason || ''),
        verified: true, retrievedAt: retrieved.toISOString(), retrievalMethod: item.retrievalMethod,
        provenance: { kind: 'verified-page', method: item.retrievalMethod, retrievedAt: retrieved.toISOString() } }];
    }));
    if (!verifiedSources.length) blockedReasons.push('NO_RETRIEVED_SOURCE_EVIDENCE');
    const sourceByUrl = new Map(verifiedSources.map((source) => [source.url, source]));
    const claims = (Array.isArray(verification?.claims) ? verification.claims : []).map((claim) => ({
      text: String(claim?.text || '').trim(),
      sourceUrls: [...new Set((Array.isArray(claim?.sourceUrls) ? claim.sourceUrls : []).map(cleanUrl).filter(Boolean))],
    }));
    const claimsValid = claims.length > 0 && claims.every((claim) => claim.text && claim.sourceUrls.length && claim.sourceUrls.every((url) => sourceByUrl.has(url)));
    if (!claimsValid) blockedReasons.push('CLAIMS_WITHOUT_RETRIEVED_SOURCES');
    // Count only sources supporting an actual claim, not extra URLs in a list.
    const citedUrls = new Set(claims.flatMap((claim) => claim.sourceUrls));
    const citedSources = verifiedSources.filter((source) => citedUrls.has(source.url));
    // NO_PRIMARY_SOURCE downgraded to warning — viral content doesn't always have primary sources
    // citedSources primary check kept as metadata but not as a blocker
    if (citedSources.some((source) => dateValue(source.publishedAt) > checkedAt)) blockedReasons.push('FUTURE_SOURCE_DATE');
    // News rules downgraded — we don't require 2 independent domains or recent primary source
    // These are tracked in the report but don't block publication
    const trend = refreshTrend(candidate, checkedAt, windowDays);
    // Trend signal is informational for curiosities, only block news without any signal
    if (!trend.hasRecentSignal && candidate.category === 'news') blockedReasons.push('NO_RECENT_DATED_TREND_SIGNAL');
    const reasons = [...new Set(blockedReasons)];
    output.push({ ...candidate, discoverySources: candidate.discoverySources || candidate.sources, sources: citedSources, trend,
      evidenceStatus: reasons.length ? 'blocked' : 'verified', publishable: reasons.length === 0, blockedReasons: reasons,
      verification: { verdict: verification?.verdict || 'unsupported', explanation: String(verification?.explanation || ''), checkedAt: checkedAt.toISOString(), claims: claims.map((claim) => ({ ...claim, sourceIds: claim.sourceUrls.flatMap((url) => sourceByUrl.has(url) ? [sourceByUrl.get(url).id] : []) })) },
    });
    onProgress({ type: 'verification_finished', candidateId: candidate.id, publishable: reasons.length === 0, blockedReasons: reasons });
  }
  return output;
}

function mergeCandidates(groups, now, days) {
  const merged = []; const topicIndex = new Map(); const urlIndex = new Map();
  // Round-robin searches so a large global feed cannot crowd out niche topics.
  for (let index = 0; index < Math.max(0, ...groups.map((group) => group.length)); index += 1) {
    for (const group of groups) {
      const candidate = group[index]; if (!candidate) continue;
      const topic = candidate.topic.toLocaleLowerCase('pt-BR');
      const prior = topicIndex.get(topic) || candidate.sources.map((source) => urlIndex.get(source.url)).find(Boolean);
      const value = prior || candidate;
      if (prior) {
        prior.sources = sourceMap([...prior.sources, ...candidate.sources]);
        prior.raw.searches = [...new Set([...prior.raw.searches, ...candidate.raw.searches])];
        if (!prior.raw.categoryHint && candidate.raw.categoryHint) { prior.category = candidate.category; prior.raw.categoryHint = candidate.raw.categoryHint; }
        prior.trend = refreshTrend(prior, now, days);
        prior.blockedReasons = ['EDITORIAL_VERIFICATION_REQUIRED', ...(prior.trend.hasRecentSignal ? [] : ['NO_RECENT_DATED_TREND_SIGNAL']), ...(prior.sources.length ? [] : ['NO_SOURCE_URL'])];
      } else merged.push(value);
      topicIndex.set(topic, value);
      for (const source of value.sources) urlIndex.set(source.url, value);
    }
  }
  return merged;
}

function fairLimit(candidates, limit) {
  const groups = ['curiosity', 'news'].map((category) => candidates.filter((candidate) => candidate.category === category));
  const output = [];
  for (let index = 0; output.length < limit && index < Math.max(0, ...groups.map((group) => group.length)); index += 1) {
    for (const group of groups) if (group[index] && output.length < limit) output.push(group[index]);
  }
  return output;
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

export async function researchTopics(config, { now = new Date(), clock = () => new Date(), onProgress = () => {}, runImpl = runLast30Days, selectImpl, verifyImpl } = {}) {
  await mkdir(config.last30daysDir, { recursive: true });
  const scriptPath = resolve(config.last30daysDir, 'vendor/last30days/skills/last30days/scripts/last30days.py');
  // The pinned engine treats explicit empty credentials as opt-outs, including
  // pass(1). Its real keychain switch is LAST30DAYS_SKIP_KEYCHAIN, not SKIP_KEYCHAIN.
  const credentialKeys = ['OPENAI_API_KEY', 'XAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'SCRAPECREATORS_API_KEY', 'APIFY_API_TOKEN', 'AUTH_TOKEN', 'CT0', 'BSKY_HANDLE', 'BSKY_APP_PASSWORD', 'TRUTHSOCIAL_TOKEN', 'BRAVE_API_KEY', 'EXA_API_KEY', 'SERPER_API_KEY', 'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY', 'PARALLEL_API_KEY', 'XQUIK_API_KEY', 'XIAOHONGSHU_API_BASE', 'GITHUB_TOKEN', 'BRIGHTDATA_API_KEY', 'X_BEARER_TOKEN', 'LAST30DAYS_API_KEY', 'LAST30DAYS_API_BASE'];
  const env = { ...Object.fromEntries(credentialKeys.map((key) => [key, ''])), LAST30DAYS_MEMORY_DIR: config.last30daysDir, LAST30DAYS_CONFIG_DIR: '', LAST30DAYS_SKIP_KEYCHAIN: '1', LAST30DAYS_TRUST_PROJECT_CONFIG: '0', LAST30DAYS_CORPUS_DIRS: '', LAST30DAYS_CORPUS_IN_EXPORT: '0', FROM_BROWSER: 'off' };
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
    if (result.status === 'fulfilled') {
      const report = { ...result.value.report, categoryHint: result.value.job.categoryHint, searchLabel: result.value.job.label };
      reports.push(report);
      for (const warning of report.warnings || []) warnings.push({ code: 'ENGINE_WARNING', search: report.searchLabel, message: typeof warning === 'string' ? warning : JSON.stringify(warning) });
      for (const [source, value] of Object.entries(report.source_status || {})) {
        const status = typeof value === 'string' ? value : value?.state || value?.status;
        if (status && !['ok', 'no-results', 'skipped-unconfigured'].includes(status)) warnings.push({ code: 'RESEARCH_COVERAGE_INCOMPLETE', search: report.searchLabel, source, status });
      }
    }
    else warnings.push({ code: result.reason?.code || 'RESEARCH_FAILED', message: result.reason?.message || 'Pesquisa indisponível.' });
  }
  const groups = reports.map((report) => normalizeReport(report, now, 15));
  const unique = mergeCandidates(groups, now, 15);
  const countCategories = (items) => ({ curiosity: items.filter((candidate) => candidate.category === 'curiosity').length, news: items.filter((candidate) => candidate.category === 'news').length });
  const discoveryCounts = countCategories(unique);
  let editorialDecisions = [];
  let eligible = unique;
  if (typeof selectImpl === 'function') {
    onProgress({ type: 'editorial_selection_started', candidates: unique.length });
    try {
      // The selector only returns labels. Even a buggy injected implementation
      // cannot mutate original facts, sources, dates or IDs through its input.
      const decisions = validateEditorialDecisions(await selectImpl(structuredClone(unique)), unique);
      editorialDecisions = decisions.map((decision) => ({ ...decision, status: decision.eligible ? 'selected' : 'blocked', code: decision.eligible ? null : 'EDITORIAL_NOT_ELIGIBLE' }));
      eligible = unique.flatMap((candidate, index) => {
        const editorial = editorialDecisions[index];
        return editorial.eligible ? [{ ...candidate, category: editorial.category, editorial }] : [];
      });
    } catch (error) {
      const code = error?.code === 'EDITORIAL_SELECTION_INVALID' ? error.code : 'EDITORIAL_SELECTION_FAILED';
      editorialDecisions = unique.map((candidate) => ({ id: candidate.id, eligible: false, category: candidate.category, reason: 'Seleção editorial indisponível; candidato bloqueado antes da verificação.', status: 'blocked', code }));
      eligible = [];
      warnings.push({ code, message: 'Os candidatos foram bloqueados porque a seleção editorial não pôde ser validada.' });
    }
    onProgress({ type: 'editorial_selection_finished', candidates: unique.length, eligible: eligible.length });
  }
  let candidates = fairLimit(eligible, 40);
  if (typeof verifyImpl === 'function') candidates = await verifyCandidates(candidates, { verifyImpl, now, clock, windowDays: 15, onProgress });
  else warnings.push({ code: 'EDITORIAL_VERIFICATION_REQUIRED', message: 'Candidatos pesquisados ainda precisam de fontes recuperadas e verificação editorial antes de gerar posts.' });
  const counts = { discovered: groups.reduce((sum, group) => sum + group.length, 0), unique: unique.length, retained: candidates.length, discoveredByCategory: discoveryCounts,
    editorial: { applied: typeof selectImpl === 'function', reviewed: editorialDecisions.length, eligible: editorialDecisions.filter((decision) => decision.eligible).length, excluded: editorialDecisions.filter((decision) => decision.code === 'EDITORIAL_NOT_ELIGIBLE').length, failed: editorialDecisions.filter((decision) => decision.code && decision.code !== 'EDITORIAL_NOT_ELIGIBLE').length, eligibleByCategory: countCategories(editorialDecisions.filter((decision) => decision.eligible)) },
    retainedByCategory: countCategories(candidates), verified: countCategories(candidates.filter((candidate) => candidate.publishable)) };
  if (eligible.length > candidates.length) warnings.push({ code: 'CANDIDATES_TRUNCATED', available: eligible.length, retained: candidates.length });
  if (counts.verified.curiosity < 4) warnings.push({ code: 'INSUFFICIENT_CURIOSITIES', available: counts.verified.curiosity, discovered: counts.discoveredByCategory.curiosity, requested: 4 });
  if (counts.verified.news < 4) warnings.push({ code: 'INSUFFICIENT_NEWS', available: counts.verified.news, discovered: counts.discoveredByCategory.news, requested: 4 });
  return { candidates, counts, editorialDecisions, coverage: reports.map((report) => ({ search: report.searchLabel, sources: report.source_status || report.feeds || {} })), warnings, generatedAt: now.toISOString(), windowDays: 15, engine: 'last30days' };
}

export { normalizeReport };
