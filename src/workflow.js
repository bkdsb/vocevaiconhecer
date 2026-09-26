import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderPost } from './render.js';
import { researchTopics } from './research.js';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function safeErrorCode(error, fallback) { return /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || '') ? error.code : fallback; }
function shuffled(items, seed) { return [...items].sort((a, b) => hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`))); }
function select(candidates, category, count, seed) { return shuffled(candidates.filter((candidate) => candidate.category === category && candidate.publishable), seed).slice(0, count); }
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

export async function createDailyBatch({ config, store, ai, renderer = renderPost, messenger, research = researchTopics, now = new Date(), targetDay = null }) {
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
  const usedTopics = new Set(before.posts.map((post) => post.topic));
  const available = result.candidates.filter((candidate) => !usedTopics.has(candidate.topic));
  const curiosityNeeded = missingSlots.filter((slot) => slot <= 4).length;
  const newsNeeded = missingSlots.filter((slot) => slot > 4).length;
  const curiosity = select(available, 'curiosity', curiosityNeeded, `${now.toISOString()}:curiosity:${localDay}`);
  const news = select(available, 'news', newsNeeded, `${now.toISOString()}:news:${localDay}`);
  if (curiosity.length !== curiosityNeeded || news.length !== newsNeeded) {
    const warning = `Pesquisa incompleta no last30days: faltam ${curiosityNeeded - curiosity.length} curiosidades e ${newsNeeded - news.length} notícias para completar o dia.`;
    store.setBatchStatus(batchId, originalStatus === 'scheduled' ? 'scheduled' : 'blocked', { warning });
    await notify('⚠️ Ainda faltam algumas pautas para completar a grade. O que já foi aprovado ou agendado foi preservado.');
    return { batchId, selected: 0, warnings: result.warnings, blocked: 'insufficient_topics', repairing };
  }
  const curiosityQueue = [...curiosity];
  const newsQueue = [...news];
  const plan = missingSlots.map((slot) => ({ slot, candidate: slot <= 4 ? curiosityQueue.shift() : newsQueue.shift() }));
  if (plan.length) await notify(repairing
    ? `🧩 Vou completar ${plan.length} espaço(s) que faltam sem mexer no que você já aprovou.`
    : '✍️ Separei 8 pautas dos últimos 15 dias. Agora vou criar as imagens e legendas para sua aprovação.');
  await mkdir(config.outputDir, { recursive: true });
  for (const { slot, candidate } of plan) {
    const copy = await ai.generateCopy(candidate);
    const generated = await ai.generateImage({ prompt: copy.imagePrompt });
    const outputPath = join(config.outputDir, `${batchId}-${slot}.png`);
    await renderer({ imageBuffer: generated.buffer, headline: copy.headline, highlights: copy.highlights, outputPath });
    const digest = contentHash({ ...copy, sources: candidate.sources, imageBuffer: await readFile(outputPath) });
    const version = digest.slice(0, 16);
    if (repairing) store.removeRejectedSlot(batchId, slot);
    const postId = repairing ? `${batchId}_p${slot}_${randomUUID().slice(0, 4)}` : `${batchId}_p${slot}`;
    store.insertPost({ id: postId, batchId, slot, category: candidate.category, topic: candidate.topic, version, contentHash: digest, headline: copy.headline, caption: copy.caption, imagePath: outputPath, sources: candidate.sources, trend: candidate.trend, status: 'pending_approval' });
    try { await messenger?.send?.({ text: `🖼️ *Prévia ${slot} de 8*\n\n*${copy.headline}*\n\n${copy.caption}\n\n📌 ${candidate.category === 'curiosity' ? 'Curiosidade' : 'Notícia'}\n🔗 Fontes: ${candidate.sources.map((source) => source.url).join(' | ')}\n\nResponda *APROVAR ${slot}* ou *REJEITAR ${slot}*.`, imagePath: outputPath }); }
    catch (error) { store.addEvent('preview_delivery_failed', { batchId, postId, code: safeErrorCode(error, 'DELIVERY_FAILED') }); }
  }
  if (store.getBatch(batchId).status !== 'paused') {
    if (originalStatus !== 'scheduled') store.setBatchStatus(batchId, 'pending_approval', { warning: null });
    scheduleBatch({ store, config, batchId, now: new Date() });
  }
  return { batchId, selected: plan.length, repaired: repairing, warnings: result.warnings };
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
  if (!['draft', 'pending_approval', 'scheduled'].includes(batch.status)) return { scheduled: false, reason: `batch_${batch.status}` };
  if (batch.posts.length !== 8) return { scheduled: false, reason: 'incomplete_batch' };
  if (batch.posts.filter((post) => post.category === 'curiosity').length !== 4) return { scheduled: false, reason: 'invalid_category_split' };
  const previouslyScheduled = batch.approved_at || batch.status === 'scheduled'
    || batch.posts.some((post) => ['scheduled', 'publishing', 'published', 'publication_unknown', 'publication_failed'].includes(post.status));
  if (!previouslyScheduled && batch.posts.some((post) => post.status !== 'approved' || !post.approved_at)) return { scheduled: false, reason: 'awaiting_approval' };
  const approved = batch.posts.filter((post) => post.status === 'approved' && post.approved_at);
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
  if (verb === 'APROVAR' && id) {
    const numericSlot = /^([1-8])$/.test(id) ? Number(id) : null;
    const latest = numericSlot ? store.latestBatch() : null;
    const resolvedId = numericSlot ? latest?.posts?.find((post) => post.slot === numericSlot)?.id : id;
    const postBefore = resolvedId ? store.getPost(resolvedId) : null;
    const suppliedVersion = command === '/VVC' ? parts[3] : parts[2];
    const versionPrefix = numericSlot && postBefore ? postBefore.version.slice(0, 8) : suppliedVersion;
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
    return { text: scheduled.scheduled ? `✅ Prévia ${numericSlot || postBefore.slot} aprovada. As prévias aprovadas estão agendadas.` : `✅ Prévia ${numericSlot || postBefore.slot} aprovada.` };
  }
  if (verb === 'REJEITAR' && id) {
    const numericSlot = /^([1-8])$/.test(id) ? Number(id) : null;
    const latest = numericSlot ? store.latestBatch() : null;
    const resolvedId = numericSlot ? latest?.posts?.find((post) => post.slot === numericSlot)?.id : id;
    const post = resolvedId ? store.rejectPost(resolvedId) : null;
    if (!post) throw Object.assign(new Error('Post não encontrado.'), { code: 'POST_NOT_FOUND' });
    return { text: `❌ Prévia ${numericSlot || post.slot} rejeitada.` };
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
  throw Object.assign(new Error('Use STATUS, APROVAR <1-8>, REJEITAR <1-8>, PAUSAR ou RETOMAR.'), { code: 'INVALID_COMMAND' });
}
