import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { renderPost } from './render.js';
import { researchTopics } from './research.js';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function shuffled(items, seed) { return [...items].sort((a, b) => hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`))); }
function select(candidates, category, count, seed) { return shuffled(candidates.filter((candidate) => candidate.category === category && candidate.publishable), seed).slice(0, count); }
function slotTimes(date = new Date(), timezone = 'America/Sao_Paulo') {
  // Slots are deterministic per local date and stay inside audience-friendly windows.
  const starts = [9 * 60 + 7, 10 * 60 + 42, 12 * 60 + 18, 13 * 60 + 53, 15 * 60 + 29, 17 * 60 + 4, 19 * 60 + 41, 21 * 60 + 16];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const offsetLabel = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value?.replace('GMT', '') || '+00:00';
  const offset = offsetLabel === '' ? '+00:00' : offsetLabel;
  // Include the timezone offset so a UTC server does not reinterpret São Paulo wall time.
  return starts.map((minutes) => `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00${offset}`);
}

export async function createDailyBatch({ config, store, ai, renderer = renderPost, messenger, research = researchTopics, now = new Date() }) {
  const result = await research(config, { now, onProgress: (event) => messenger?.send?.({ text: `Pesquisa: ${event.type}` }).catch?.(() => {}) });
  const curiosity = select(result.candidates, 'curiosity', 4, now.toISOString());
  const news = select(result.candidates, 'news', 4, `${now.toISOString()}:news`);
  const selected = [...curiosity, ...news];
  const batchId = `batch_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;
  store.createBatch({ id: batchId, warning: result.warnings.length ? JSON.stringify(result.warnings) : null });
  await mkdir(config.outputDir, { recursive: true });
  for (const [index, candidate] of selected.entries()) {
    const copy = await ai.generateCopy(candidate);
    const generated = await ai.generateImage({ prompt: copy.imagePrompt });
    const outputPath = join(config.outputDir, `${batchId}-${index + 1}.png`);
    await renderer({ imageBuffer: generated.buffer, headline: copy.headline, highlights: copy.highlights, outputPath });
    const version = hash(JSON.stringify({ candidate, copy, image: generated.id })).slice(0, 16);
    const postId = `${batchId}_p${index + 1}`;
    store.insertPost({ id: postId, batchId, slot: index + 1, category: candidate.category, topic: candidate.topic, version, headline: copy.headline, caption: copy.caption, imagePath: outputPath, sources: candidate.sources, trend: candidate.trend, status: config.approvalRequired ? 'pending_approval' : 'approved' });
    await messenger?.send?.({ text: `LOTE ${batchId}\nPOST ${index + 1}/8\n${copy.headline}\nCategoria: ${candidate.category}\nTendência: ${candidate.trend.label}\nFontes: ${candidate.sources.map((source) => source.url).join(' | ')}\n\nResponda APROVAR ${postId} ${version.slice(0, 8)} ou REJEITAR ${postId}`, imagePath: outputPath }).catch?.(() => {});
  }
  if (selected.length !== 8) store.setBatchStatus(batchId, 'blocked', { warning: `Lote incompleto: ${selected.length}/8 posts verificados.` });
  else if (!config.approvalRequired) scheduleBatch({ store, config, batchId, now });
  return { batchId, selected: selected.length, warnings: result.warnings };
}

export function scheduleBatch({ store, config, batchId, now = new Date() }) {
  const batch = store.getBatch(batchId); if (!batch) throw new Error('Lote não encontrado.');
  if (batch.status === 'blocked') return { scheduled: false, reason: 'blocked_incomplete_batch' };
  if (batch.posts.length !== 8) return { scheduled: false, reason: 'incomplete_batch' };
  if (config.approvalRequired && batch.posts.some((post) => post.status !== 'approved')) return { scheduled: false, reason: 'awaiting_approval' };
  const times = slotTimes(now, config.timezone);
  for (const post of batch.posts) { if (post.status === 'approved') store.markScheduled(post.id, times[post.slot - 1]); }
  store.setBatchStatus(batchId, 'scheduled');
  return { scheduled: true, times };
}

export async function publishDue({ store, meta, config, now = new Date() }) {
  if (!config.metaPublishEnabled) return { published: 0, skipped: 'META_PUBLISH_ENABLED=false' };
  const due = store.listReady().filter((post) => post.status === 'scheduled' && post.scheduled_at && new Date(post.scheduled_at) <= now);
  let published = 0;
  for (const post of due) {
    try { const result = await meta.publishPhoto({ pageId: config.metaPageId, pageToken: config.metaPageToken, imagePath: post.image_path, caption: post.caption, published: true }); store.markPublished(post.id, result); published += 1; }
    catch (error) { if (error.code === 'PUBLICATION_UNKNOWN') store.markUnknown(post.id, error.message); else store.addEvent('publication_failed', { postId: post.id, error: error.code || 'unknown' }); }
  }
  return { published, due: due.length };
}

export async function handleApprovalCommand({ text, sender, config, store, batchId = null, now = new Date() }) {
  if (!config.allowedSenders.includes(sender)) { const error = new Error('Remetente não autorizado.'); error.code = 'UNAUTHORIZED_SENDER'; throw error; }
  const value = String(text).trim(); const parts = value.split(/\s+/); const command = parts[0].toUpperCase();
  if (command === 'STATUS' || command === '/VVC' && parts[1]?.toUpperCase() === 'STATUS') return { text: JSON.stringify(store.latestBatch() || { status: 'none' }) };
  const verb = command === '/VVC' ? parts[1]?.toUpperCase() : command; const id = command === '/VVC' ? parts[2] : parts[1];
  if (verb === 'APROVAR' && id) {
    const versionPrefix = command === '/VVC' ? parts[3] : parts[2];
    const postBefore = store.getPost(id);
    if (!postBefore) throw Object.assign(new Error('Post não encontrado.'), { code: 'POST_NOT_FOUND' });
    if (!versionPrefix || !postBefore.version.startsWith(versionPrefix)) throw Object.assign(new Error(`Versão inválida. Use APROVAR ${id} ${postBefore.version.slice(0, 8)}.`), { code: 'STALE_VERSION' });
    const post = store.approvePost(id);
    if (!post) throw Object.assign(new Error('Post já não está aguardando aprovação.'), { code: 'POST_NOT_PENDING' });
    const targetBatch = store.getBatch(post.batch_id);
    const allApproved = targetBatch?.posts.length > 0 && targetBatch.posts.every((item) => item.status === 'approved');
    const scheduled = allApproved ? scheduleBatch({ store, config, batchId: post.batch_id, now }) : { scheduled: false };
    return { text: scheduled.scheduled ? `Aprovado ${id}. Todos os posts do lote foram aprovados e estão agendados.` : `Aprovado ${id}.` };
  }
  if (verb === 'REJEITAR' && id) { const post = store.rejectPost(id); if (!post) throw Object.assign(new Error('Post não encontrado.'), { code: 'POST_NOT_FOUND' }); return { text: `Rejeitado ${id}.` }; }
  const targetBatchId = batchId || store.latestBatch()?.id;
  if (verb === 'PAUSAR') { if (targetBatchId) store.setBatchStatus(targetBatchId, 'paused', { paused_at: new Date().toISOString() }); return { text: 'Publicação pausada.' }; }
  if (verb === 'RETOMAR') { if (targetBatchId) store.setBatchStatus(targetBatchId, 'draft', { paused_at: null }); return { text: 'Publicação retomada.' }; }
  throw Object.assign(new Error('Use STATUS, APROVAR <id> <versão>, REJEITAR <id>, PAUSAR ou RETOMAR.'), { code: 'INVALID_COMMAND' });
}
