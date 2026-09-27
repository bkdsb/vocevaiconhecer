import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderPost } from './render.js';
import { researchTopics } from './research.js';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
const TOPIC_STOPWORDS = new Set(['a','ao','aos','as','com','da','das','de','do','dos','e','em','for','from','in','o','of','os','para','por','the','to','um','uma','with']);
function normalizedWords(value) {
  return new Set(String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter((word) => (word.length > 2 || word === 'ai' || word === 'ia') && !TOPIC_STOPWORDS.has(word)));
}
export function storyArchetypes(value) {
  const text = ` ${String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR')} `;
  const rules = [
    ['tragedy-extreme-event', /(trag[eé]dia|desastre|terremoto|enchente|inc[eê]ndio|acidente|desabamento|cat[aá]strofe|mortes?)/u],
    ['ocean-animal', /(polvo|tubar[aã]o|baleia|golfinho|peixe|oceano|marinho|marinha|abissal|coral)/u],
    ['extraordinary-animal', /(animal|esp[eé]cie|superpoder|veneno|biolum|camuflag|regenera|capacidade incomum)/u],
    ['human-achievement', /(recorde|campe[aã]o|feito humano|supera[cç][aã]o|atleta|conquista|primeiro humano)/u],
    ['medical-breakthrough', /(cura|tratamento|terapia|medicina|doen[cç]a|paciente|vacina|transplante)/u],
    ['science-discovery', /(descoberta|cientista|pesquisa|estudo|f[oó]ssil|arqueolog|experimento)/u],
    ['technology-ai', /(tecnolog|intelig[eê]ncia artificial|\bia\b|\bai\b|rob[oô]|chip|software|computador)/u],
    ['mystery-supernatural', /(mist[eé]rio|sobrenatural|fantasma|ovni|ufo|inexplic[aá]vel|assombra)/u],
    ['politics-controversy', /(pol[ií]tic|governo|presidente|congresso|stf|elei[cç][aã]o|ministro|pol[eê]mic|divide opini)/u],
    ['religion-controversy', /(religi[aã]o|igreja|padre|pastor|papa|milagre|f[eé]|b[ií]blia)/u],
    ['space-universe', /(espa[cç]o|universo|planeta|estrela|aster[oó]ide|nasa|lua|marte)/u],
    ['weird-unbelievable', /(bizar|absurd|estranh|parece mentira|inacredit[aá]vel|in[eé]dit|nunca visto)/u],
    ['brazil-regional', /(brasil|brasileir|nordeste|sul|paran[aá]|bahia|cear[aá]|pernambuco|rio grande do sul|santa catarina)/u],
  ];
  return new Set(rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name));
}
function recentEntities(value) {
  const ignored = new Set(['Brasil','Brazil','Cientistas','Pesquisadores','Governo','Estudo','Pesquisa','Novo','Nova','Homem','Mulher','Mundo','Por','Como','Uma','Uns','Isso','Esta','Este']);
  return new Set((String(value || '').match(/\b[\p{Lu}][\p{L}\d-]{2,}(?:\s+[\p{Lu}][\p{L}\d-]{2,}){0,2}\b/gu) || []).filter((item) => !ignored.has(item)));
}
function themeTags(value) {
  const text = ` ${String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR')} `;
  const tags = [];
  if (/\b(ai|ia|artificial intelligence|inteligencia artificial|llm|gpt|openai|anthropic|claude)\b/u.test(text)) tags.push('artificial-intelligence');
  if (/\b(nuclear|chernobyl|reator|reactor)\b/u.test(text)) tags.push('nuclear-energy');
  if (/\b(mouse|mice|camundongo|brain|cerebro|neurolog)\b/u.test(text)) tags.push('brain-research');
  if (/\b(nixos|microsoft|sovereignty|soberania digital)\b/u.test(text)) tags.push('digital-sovereignty');
  return new Set(tags);
}
function canonicalUrl(value) {
  try { const url = new URL(value); return `${url.hostname.replace(/^www\./u, '')}${url.pathname.replace(/\/$/u, '')}`.toLocaleLowerCase('pt-BR'); }
  catch { return ''; }
}
function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0; for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}
export function repeatsRememberedTopic(candidate, memories, now = new Date()) {
  const candidateWords = normalizedWords(`${candidate.topic || ''} ${candidate.summary || ''}`);
  const candidateThemes = themeTags(`${candidate.topic || ''} ${candidate.summary || ''}`);
  const candidateEntities = recentEntities(`${candidate.topic || ''} ${candidate.summary || ''}`);
  const candidateUrls = new Set((candidate.sources || []).map((source) => canonicalUrl(source.url)).filter(Boolean));
  return memories.some((memory) => {
    const rememberedAt = Date.parse(memory.remembered_at || memory.rememberedAt || '');
    const entityCooldown = Number.isFinite(rememberedAt) && now.getTime() - rememberedAt <= 14 * 86_400_000;
    if (entityCooldown) {
      const rememberedEntities = recentEntities(`${memory.topic || ''} ${memory.headline || ''}`);
      if ([...candidateEntities].some((entity) => rememberedEntities.has(entity))) return true;
    }
    const rememberedUrls = new Set((memory.sources || []).map((source) => canonicalUrl(source.url)).filter(Boolean));
    if ([...candidateUrls].some((url) => rememberedUrls.has(url))) return true;
    const topicScore = overlap(normalizedWords(memory.topic), normalizedWords(candidate.topic));
    const contextScore = overlap(normalizedWords(`${memory.topic} ${memory.headline}`), candidateWords);
    return topicScore >= 0.8 || contextScore >= 0.72;
  });
}
export function freshEnoughForPublication(candidate, now = new Date()) {
  if (!requiresOneDayFreshness(candidate)) return true;
  const newest = Math.max(0, ...(candidate.sources || []).map((source) => Date.parse(source.publishedAt || '')).filter(Number.isFinite));
  return newest > 0 && newest >= now.getTime() - 86_400_000 && newest <= now.getTime() + 5 * 60_000;
}
function safeErrorCode(error, fallback) { return /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || '') ? error.code : fallback; }
function shuffled(items, seed) { return [...items].sort((a, b) => hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`))); }
function winnerSubjectWords(value) {
  const generic = new Set(['brasil','mundo','natureza','historia','histórica','historica','novo','nova','tecnologia','cientistas','pesquisadores','pessoas','cidade','regiao','região','profundezas','oceano','animal','animais','tragedia','tragédia','desastre','curioso','curiosa','incrivel','incrível','parece','mentira','verdade']);
  return new Set([...normalizedWords(String(value || '').slice(0, 600))].filter((word) => word.length >= 5 && !generic.has(word)));
}
export function repeatsHistoricalWinnerSubject(candidate, winners = []) {
  const candidateWords = winnerSubjectWords(`${candidate.topic || ''} ${candidate.summary || ''}`);
  const candidateEntities = recentEntities(`${candidate.topic || ''} ${candidate.summary || ''}`);
  return winners.some((winner) => {
    const source = String(winner.message || winner.topic || winner.headline || '').slice(0, 600);
    const winnerEntities = recentEntities(source);
    if ([...candidateEntities].some((entity) => winnerEntities.has(entity))) return true;
    const winnerWords = winnerSubjectWords(source);
    const sharedSpecific = [...candidateWords].filter((word) => winnerWords.has(word));
    return sharedSpecific.length >= 2 || sharedSpecific.some((word) => /^(nepal|tibete|galapagos|galápagos|microeledone|polvo|everest)$/u.test(word));
  });
}
function performanceAffinity(candidate, profiles = []) {
  if (!profiles.length) return 0;
  const candidateWords = normalizedWords(`${candidate.topic || ''} ${candidate.summary || ''}`);
  const candidateArchetypes = storyArchetypes(`${candidate.topic || ''} ${candidate.summary || ''}`);
  const winners = profiles.filter((profile) => profile.historicalWinner === true);
  let winnerBonus = 0;
  if (winners.length) {
    const index = Number.parseInt(hash(`${candidate.id || candidate.topic}:winner`).slice(0, 8), 16) % winners.length;
    const winner = winners[index];
    const winnerArchetypes = storyArchetypes(winner.message || `${winner.topic || ''} ${winner.headline || ''}`);
    const archetypeSimilarity = overlap(candidateArchetypes, winnerArchetypes);
    if (archetypeSimilarity > 0) winnerBonus = Math.min(3.2, 1.4 + archetypeSimilarity * 2.2);
  }
  let externalBonus = 0;
  for (const profile of profiles.filter((item) => item.historicalWinner !== true)) {
    const similarity = overlap(candidateWords, normalizedWords(`${profile.topic || ''} ${profile.headline || ''}`));
    const categoryBonus = similarity >= 0.12 && candidate.category === profile.category ? 0.5 : 0;
    externalBonus = Math.max(externalBonus, similarity * 2.5 + categoryBonus);
  }
  return Math.min(4, winnerBonus + Math.min(1.2, externalBonus));
}
function editorialAppeal(candidate, profiles = []) {
  const text = `${candidate.topic || ''} ${candidate.summary || ''}`.toLocaleLowerCase('pt-BR');
  const hook = /(surpre|incr[ií]vel|estranh|bizar|absurd|imposs[ií]vel|parece mentira|rar[oa]|mister|sobrenatural|in[eé]dit|descob|recorde|campe[aã]o|primeir|nunca|gigante|min[uú]scul|superpoder|feito extraordin[aá]rio|animal|espa[cç]o|universo|c[eé]rebro|sono|oceano|planeta|rob[oô]|ia\b|intelig[eê]ncia artificial|cura|tratamento|avan[cç]o|vida|humano|viral|pol[eê]mic|divide opini|por que|como)/iu.test(text) ? 5 : 0;
  const technical = /(transcript[oô]mica|prote[oô]mica|metabol[oô]mica|filogen|taxonom|gen[oô]mica comparativa|ensaio de fase [ivx]+|mecanismo molecular|express[aã]o g[eê]nica|distribui[cç][aã]o geogr[aá]fica antiga|heterogeneidade|polimorfismo)/iu.test(text) ? -6 : 0;
  const metrics = Object.values(candidate.trend?.aggregateMetrics || {}).flatMap((value) => typeof value === 'number' ? [value] : value && typeof value === 'object' ? Object.values(value).filter((n) => typeof n === 'number') : []);
  const engagement = metrics.length ? Math.min(5, Math.log10(1 + Math.max(...metrics))) : 0;
  const concise = String(candidate.topic || '').split(/\s+/u).length <= 16 ? 1 : -1;
  return hook + technical + engagement + concise + performanceAffinity(candidate, profiles);
}
function requiresOneDayFreshness(candidate) {
  const text = `${candidate.topic || ''} ${candidate.summary || ''} ${candidate.headline || ''}`.toLocaleLowerCase('pt-BR');
  return /(pol[ií]tic|politic|governo|government|presidente|president|congresso|congress|senado|senate|deputad|elei[cç][aã]o|election|decreto|decree|regula[cç][aã]o|regulation|proibi[cç][aã]o|\bban\b|stf\b|supremo|partido|party\b|ministro|minister|intelig[eê]ncia artificial|artificial intelligence|\bia\b|\bai\b|tecnolog|technology|software|aplicativo|app\b|rob[oô]|robot|chip|computador|computer|smartphone|modelo de linguagem|language model|chatbot)/iu.test(text);
}
function withinOneDay(candidate, now = new Date()) {
  const dates = (candidate.sources || []).map((source) => source.publishedAt).filter(Boolean).map((value) => new Date(value)).filter((date) => Number.isFinite(date.getTime()));
  if (!dates.length) return false;
  const newest = Math.max(...dates.map((date) => date.getTime()));
  return newest <= now.getTime() + 5 * 60_000 && newest >= now.getTime() - 24 * 60 * 60_000;
}
function select(candidates, category, count, seed, now = new Date(), profiles = []) {
  return shuffled(candidates.filter((candidate) => candidate.category === category && candidate.publishable && (!requiresOneDayFreshness(candidate) || withinOneDay(candidate, now))), seed)
    .sort((a, b) => editorialAppeal(b, profiles) - editorialAppeal(a, profiles))
    .slice(0, count);
}
export function slotTimes(date = new Date(), timezone = 'America/Sao_Paulo') {
  // Slots are deterministic per local date and stay inside audience-friendly windows.
  const starts = [10 * 60, 11 * 60, 12 * 60, 13 * 60, 18 * 60, 19 * 60, 20 * 60, 21 * 60];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const offsetLabel = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value?.replace('GMT', '') || '+00:00';
  const offset = offsetLabel === '' ? '+00:00' : offsetLabel;
  // Include the timezone offset so a UTC server does not reinterpret São Paulo wall time.
  return starts.map((minutes) => `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00${offset}`);
}

export function contentHash({ headline, caption, sources, imageBuffer }) {
  return hash(Buffer.concat([Buffer.from(JSON.stringify({ headline, caption, sources })), imageBuffer]));
}

function futureSlots({ store, config, count, now, excludeIds = [], reservedExtra = [] }) {
  const reserved = new Set([...store.reservedTimes(excludeIds), ...reservedExtra].map((at) => new Date(at).getTime()));
  const result = [];
  const threshold = now.getTime() + 5 * 60_000;
  for (let day = 0; day < 30 && result.length < count; day += 1) {
    for (const at of slotTimes(new Date(now.getTime() + day * 86_400_000), config.timezone)) {
      const time = new Date(at).getTime();
      if (time >= threshold && !reserved.has(time)) { result.push(at); reserved.add(time); }
      if (result.length === count) break;
    }
  }
  if (result.length !== count) throw new Error('Sem horários livres nos próximos 30 dias.');
  return result;
}

function plannedSlots({ store, config, count, now, targetDay, excludeIds = [] }) {
  if (!targetDay) return futureSlots({ store, config, count, now, excludeIds });
  const reserved = new Set(store.reservedTimes(excludeIds).map((at) => new Date(at).getTime()));
  const threshold = now.getTime() + 5 * 60_000;
  const targetDate = new Date(`${targetDay}T12:00:00Z`);
  const preferred = slotTimes(targetDate, config.timezone).filter((at) => new Date(at).getTime() >= threshold && !reserved.has(new Date(at).getTime()));
  const selected = preferred.slice(0, count);
  if (selected.length === count) return selected;
  return selected.concat(futureSlots({ store, config, count: count - selected.length, now, excludeIds, reservedExtra: selected }));
}

export async function createDailyBatch({ config, store, ai, renderer = renderPost, messenger, research = researchTopics, now = new Date(), targetDay = null, notifyProgress = true }) {
  const localDay = targetDay || new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const existing = store.batchForDay(localDay);
  let batchId;
  let repairing = false;
  let originalStatus = null;
  if (existing) {
    const current = store.getBatch(existing.id);
    const needsRepair = current && (current.posts.length < 8 || current.posts.some((post) => post.status === 'rejected'));
    const repairable = current && ['blocked', 'pending_approval', 'scheduled'].includes(current.status) && needsRepair;
    if (!repairable) return { batchId: existing.id, skipped: 'already_created_today' };
    batchId = existing.id;
    repairing = true;
    originalStatus = current.status;
    if (originalStatus !== 'scheduled') store.setBatchStatus(batchId, 'generating', { warning: null });
  } else {
    batchId = `batch_${localDay.replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;
    try { store.createBatch({ id: batchId, createdAt: now.toISOString(), localDay, status: 'generating' }); }
    catch (error) { const claimed = store.batchForDay(localDay); if (claimed) return { batchId: claimed.id, skipped: 'already_created_today' }; throw error; }
  }
  let notices = Promise.resolve();
  const notify = (text) => {
    if (!notifyProgress) return notices;
    notices = notices.then(() => messenger?.send?.({ text }))
      .catch((error) => { store.addEvent('progress_delivery_failed', { batchId, code: safeErrorCode(error, 'DELIVERY_FAILED') }); });
    return notices;
  };
  try {
  await notify('🔎 Estou buscando boas pautas recentes e conferindo as fontes.');
  const result = await research(config, { now, onProgress: () => {} });
  const before = store.getBatch(batchId);
  const occupied = new Set(before.posts.filter((post) => post.status !== 'rejected').map((post) => post.slot));
  const missingSlots = Array.from({ length: 8 }, (_, index) => index + 1).filter((slot) => !occupied.has(slot));
  const memories = store.topicMemory();
  const historicalTop10 = store.historicalPerformanceProfiles?.(10) || [];
  const top5Winners = [...historicalTop10.slice(0, 5)]
    .sort((a, b) => hash(`${batchId}:${localDay}:${a.meta_post_id}`).localeCompare(hash(`${batchId}:${localDay}:${b.meta_post_id}`)))
    .map((profile) => ({ ...profile, historicalWinner: true }));
  const fallbackPerformance = top5Winners.length ? [] : (store.performanceProfiles?.(5) || []);
  const editorialProfiles = [...top5Winners, ...fallbackPerformance, ...(result.inspirationProfiles || [])];
  const available = result.candidates.filter((candidate) => freshEnoughForPublication(candidate, now) && !repeatsRememberedTopic(candidate, memories, now) && !repeatsHistoricalWinnerSubject(candidate, top5Winners));
  const curiosityNeeded = missingSlots.filter((slot) => slot <= 4).length;
  const newsNeeded = missingSlots.filter((slot) => slot > 4).length;
  const curiosity = select(available, 'curiosity', curiosityNeeded, `${now.toISOString()}:curiosity:${localDay}`, now, editorialProfiles);
  const news = select(available, 'news', newsNeeded, `${now.toISOString()}:news:${localDay}`, now, editorialProfiles);
  const curiosityQueue = [...curiosity];
  const newsQueue = [...news];
  const plan = missingSlots.flatMap((slot) => {
    const candidate = slot <= 4 ? curiosityQueue.shift() : newsQueue.shift();
    return candidate ? [{ slot, candidate }] : [];
  });
  const curiosityRemaining = curiosityNeeded - curiosity.length;
  const newsRemaining = newsNeeded - news.length;
  const incomplete = curiosityRemaining > 0 || newsRemaining > 0;
  if (!plan.length) {
    const warning = `Pesquisa incompleta no last30days: faltam ${curiosityRemaining} curiosidades e ${newsRemaining} notícias para completar o dia.`;
    store.setBatchStatus(batchId, originalStatus === 'scheduled' ? 'scheduled' : 'blocked', { warning });
    store.addEvent('research_incomplete', { batchId, curiosityRemaining, newsRemaining, selected: 0 });
    await notify('⚠️ Ainda faltam algumas pautas para completar a grade. O que já foi aprovado ou agendado foi preservado.');
    return { batchId, selected: 0, warnings: result.warnings, blocked: 'insufficient_topics', repairing, remaining: { curiosity: curiosityRemaining, news: newsRemaining } };
  }
  if (plan.length) await notify(repairing
    ? `🧩 Vou completar ${plan.length} espaço(s) que faltam sem mexer no que você já aprovou.`
    : '✍️ Separei 8 pautas dos últimos 15 dias. Agora vou criar as imagens e legendas para sua aprovação.');
  await mkdir(config.outputDir, { recursive: true });
  for (const { slot, candidate } of plan) {
    const copy = await ai.generateCopy(candidate);
    const generated = await ai.generateImage({ prompt: copy.imagePrompt });
    const postId = repairing ? `${batchId}_p${slot}_${randomUUID().slice(0, 4)}` : `${batchId}_p${slot}`;
    // Every reviewed version keeps its own file. Replacements must never overwrite
    // the visual evidence of an older or rejected preview.
    const outputPath = join(config.outputDir, `${postId}.png`);
    await renderer({ imageBuffer: generated.buffer, headline: copy.headline, highlights: copy.highlights, outputPath });
    const digest = contentHash({ ...copy, sources: candidate.sources, imageBuffer: await readFile(outputPath) });
    const version = digest.slice(0, 16);
    if (repairing) store.removeRejectedSlot(batchId, slot);
    store.insertPost({ id: postId, batchId, slot, category: candidate.category, topic: candidate.topic, version, contentHash: digest, headline: copy.headline, caption: copy.caption, imagePath: outputPath, sources: candidate.sources, trend: candidate.trend, status: 'pending_approval' });
    const approvalCode = store.approvalCode(postId);
    if (!approvalCode) throw Object.assign(new Error('Não foi possível criar o código sequencial da prévia.'), { code: 'APPROVAL_CODE_FAILED' });
    try { await messenger?.send?.({ text: `${copy.caption}\n\nCódigo desta prévia: *${approvalCode}*\nResponda *APROVAR ${approvalCode}* ou *REJEITAR ${approvalCode}*.`, imagePath: outputPath }); }
    catch (error) { store.addEvent('preview_delivery_failed', { batchId, postId, code: safeErrorCode(error, 'DELIVERY_FAILED') }); }
  }
  if (store.getBatch(batchId).status !== 'paused') {
    const warning = incomplete ? `Pesquisa parcialmente concluída: faltam ${curiosityRemaining} curiosidades e ${newsRemaining} notícias para completar o dia.` : null;
    if (originalStatus !== 'scheduled') store.setBatchStatus(batchId, 'pending_approval', { warning });
    else if (warning) store.setBatchStatus(batchId, 'scheduled', { warning });
    if (incomplete) store.addEvent('research_incomplete', { batchId, curiosityRemaining, newsRemaining, selected: plan.length });
    scheduleBatch({ store, config, batchId, now: new Date() });
  }
  return { batchId, selected: plan.length, repaired: repairing, partial: incomplete, remaining: { curiosity: curiosityRemaining, news: newsRemaining }, warnings: result.warnings };
  } catch (error) {
    const code = safeErrorCode(error, 'GENERATION_FAILED');
    store.setBatchStatus(batchId, originalStatus === 'scheduled' ? 'scheduled' : 'blocked', { warning: `Geração interrompida: ${code}. O que já estava aprovado ou agendado foi preservado.` });
    await notify('⚠️ Não consegui concluir todas as novas prévias. O que você já aprovou ou agendou foi preservado.');
    throw error;
  }
}

export function scheduleBatch({ store, config, batchId, now = new Date() }) {
  return store.transaction(() => {
  const batch = store.getBatch(batchId); if (!batch) throw new Error('Lote não encontrado.');
  if (batch.status === 'paused') return { scheduled: false, reason: 'batch_paused' };
  if (!['generating', 'draft', 'pending_approval', 'scheduled', 'blocked'].includes(batch.status)) return { scheduled: false, reason: `batch_${batch.status}` };
  const approved = batch.posts
    .filter((post) => post.status === 'approved' && post.approved_at)
    .sort((a, b) => a.slot - b.slot);
  if (!approved.length) return { scheduled: false, reason: 'no_approved_posts' };
  const times = plannedSlots({ store, config, count: approved.length, now, targetDay: batch.local_day });
  approved.forEach((post, index) => store.markScheduled(post.id, times[index]));
  store.setBatchStatus(batchId, 'scheduled', { approved_at: batch.approved_at || now.toISOString() });
  return { scheduled: true, times };
  });
}

export async function publishDue({ store, meta, config, now = new Date() }) {
  if (!config.metaPublishEnabled) return { published: 0, skipped: 'META_PUBLISH_ENABLED=false' };
  const earliest = new Date(now.getTime() - 15 * 60_000).toISOString();
  store.transaction(() => {
    const expired = store.listReady().filter((post) => post.status === 'scheduled' && store.getBatch(post.batch_id)?.status === 'scheduled' && new Date(post.scheduled_at) < new Date(earliest));
    const times = futureSlots({ store, config, count: expired.length, now, excludeIds: expired.map((post) => post.id) });
    expired.forEach((post, index) => store.reschedule(post.id, times[index]));
  });
  const due = store.listReady().filter((post) => post.status === 'scheduled' && post.scheduled_at && new Date(post.scheduled_at) <= now && store.getBatch(post.batch_id)?.status === 'scheduled');
  let published = 0;
  for (const post of due) {
    if (requiresOneDayFreshness(post) && !withinOneDay(post, now)) {
      store.rejectPost(post.id, 'FRESHNESS_EXPIRED');
      store.addEvent('post_freshness_expired', { batchId: post.batch_id, postId: post.id });
      continue;
    }
    let imageBuffer;
    try { imageBuffer = await readFile(post.image_path); } catch { store.invalidatePost(post.id, 'Imagem não encontrada; requer revisão.'); continue; }
    if (!post.content_hash || contentHash({ ...post, imageBuffer }) !== post.content_hash) {
      store.invalidatePost(post.id, 'Conteúdo mudou ou não possui hash; requer nova revisão.'); continue;
    }
    if (!store.claimPublication(post.id, now.toISOString(), earliest, new Date(now.getTime() - 60 * 60_000).toISOString(), post)) continue;
    try { const result = await meta.publishPhoto({ pageId: config.metaPageId, pageToken: config.metaPageToken, imageBuffer, imagePath: post.image_path, caption: post.caption, published: true }); store.markPublished(post.id, result, now.toISOString()); published += 1; }
    catch (error) {
      if (['META_REJECTED', 'META_CONFIG', 'META_INVALID_INPUT'].includes(error.code)) store.markFailed(post.id, error.code);
      else store.markUnknown(post.id, error.code || 'PUBLICATION_UNKNOWN');
      store.addEvent('publication_failed', { postId: post.id, error: error.code || 'unknown' });
    }
  }
  return { published, due: due.length };
}

export async function handleApprovalCommand({ text, sender, config, store, batchId = null, now = new Date() }) {
  if (!config.allowedSenders.includes(sender)) { const error = new Error('Remetente não autorizado.'); error.code = 'UNAUTHORIZED_SENDER'; throw error; }
  const value = String(text).trim(); const parts = value.split(/\s+/); const command = parts[0].toUpperCase();
  if (command === 'STATUS' || command === '/VVC' && parts[1]?.toUpperCase() === 'STATUS') return { text: JSON.stringify(store.latestBatch() || { status: 'none' }) };
  const verb = command === '/VVC' ? parts[1]?.toUpperCase() : command; const id = command === '/VVC' ? parts[2] : parts[1];
  const sequentialCode = /^0\d{3,}$/.test(id || '') ? id : null;
  const code = /^([a-f0-9]{8,16})$/i.test(id || '') ? id.toLowerCase() : null;
  const resolvePost = () => {
    if (sequentialCode) return store.findPostByApprovalCode?.(sequentialCode) || null;
    if (code) {
      const matches = store.findPostsByVersionPrefix?.(code) || [];
      if (matches.length > 1) throw Object.assign(new Error('Código ambíguo. Use o código completo mostrado na prévia.'), { code: 'AMBIGUOUS_POST_CODE' });
      return matches[0] || null;
    }
    if (/^([1-8])$/.test(id || '')) return store.latestBatch()?.posts?.find((post) => post.slot === Number(id)) || null;
    return id ? store.getPost(id) : null;
  };
  if (verb === 'APROVAR' && id) {
    const numericSlot = /^([1-8])$/.test(id) ? Number(id) : null;
    const postBefore = resolvePost();
    const resolvedId = postBefore?.id;
    const suppliedVersion = command === '/VVC' ? parts[3] : parts[2];
    const versionPrefix = code || suppliedVersion || ((sequentialCode || numericSlot) && postBefore ? postBefore.version.slice(0, 8) : undefined);
    if (!postBefore) throw Object.assign(new Error('Post não encontrado.'), { code: 'POST_NOT_FOUND' });
    if (!/^[a-f0-9]{8,16}$/i.test(versionPrefix || '') || !postBefore.version.startsWith(versionPrefix)) throw Object.assign(new Error(`Versão inválida. Use APROVAR ${id} ${postBefore.version.slice(0, 8)}.`), { code: 'STALE_VERSION' });
    let imageBuffer;
    try { imageBuffer = await readFile(postBefore.image_path); }
    catch { throw Object.assign(new Error('Imagem indisponível; restaure ou gere uma nova prévia antes de aprovar.'), { code: 'CONTENT_UNAVAILABLE' }); }
    if (!postBefore.content_hash || contentHash({ ...postBefore, imageBuffer }) !== postBefore.content_hash) {
      throw Object.assign(new Error('O conteúdo difere da prévia. Restaure ou gere uma nova versão para revisão.'), { code: 'CONTENT_CHANGED' });
    }
    const post = store.approvePost(resolvedId, now.toISOString(), postBefore);
    if (!post) throw Object.assign(new Error('Post já não está aguardando aprovação.'), { code: 'POST_NOT_PENDING' });
    const scheduled = scheduleBatch({ store, config, batchId: post.batch_id, now });
    const reference = sequentialCode || code?.toUpperCase() || numericSlot || postBefore.slot;
    return { text: scheduled.scheduled ? `✅ Prévia ${reference} aprovada. As prévias aprovadas estão agendadas.` : `✅ Prévia ${reference} aprovada.` };
  }
  if (verb === 'REJEITAR' && id) {
    const numericSlot = /^([1-8])$/.test(id) ? Number(id) : null;
    const target = resolvePost();
    const post = target ? store.rejectPost(target.id) : null;
    if (!post) throw Object.assign(new Error('Post não encontrado.'), { code: 'POST_NOT_FOUND' });
    return { text: `❌ Prévia ${sequentialCode || code?.toUpperCase() || numericSlot || post.slot} rejeitada. Vou buscar outro tema para esse espaço e te enviar uma nova prévia para aprovação.` };
  }
  const targetBatchId = id || batchId || store.latestBatch()?.id;
  const targetBatch = targetBatchId && store.getBatch(targetBatchId);
  if (verb === 'PAUSAR') {
    if (!targetBatch) return { text: 'Nenhum lote encontrado para pausar.' };
    store.setBatchStatus(targetBatchId, 'paused', { paused_at: now.toISOString() });
    return { text: `Lote ${targetBatchId} pausado. Um envio que já começou pode terminar.` };
  }
  if (verb === 'RETOMAR') {
    if (!targetBatch || targetBatch.status !== 'paused') return { text: 'Nenhum lote pausado encontrado.' };
    store.transaction(() => {
      const batch = store.getBatch(targetBatchId);
      const scheduled = batch.posts.filter((post) => post.status === 'scheduled');
      const times = futureSlots({ store, config, count: scheduled.length, now, excludeIds: scheduled.map((post) => post.id) });
      scheduled.forEach((post, index) => store.reschedule(post.id, times[index]));
      store.setBatchStatus(targetBatchId, batch.posts.length === 8 ? (scheduled.length ? 'scheduled' : 'pending_approval') : 'blocked', { paused_at: null });
    });
    scheduleBatch({ store, config, batchId: targetBatchId, now });
    return { text: `Lote ${targetBatchId} retomado. Somente posts aprovados podem ser agendados; horários antigos foram redistribuídos.` };
  }
  throw Object.assign(new Error('Use STATUS, APROVAR <CÓDIGO>, REJEITAR <CÓDIGO>, PAUSAR ou RETOMAR.'), { code: 'INVALID_COMMAND' });
}
