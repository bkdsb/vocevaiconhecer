import { createAIProvider } from './providers/ai.js';
import { createOpenClawProvider } from './providers/openclaw.js';
import { createMetaProvider } from './providers/meta.js';
import { createDailyBatch, expireStalePosts, publishDue, syncSchedulesWithMeta } from './workflow.js';
import { startTask, taskStatus } from './task-runner.js';
import { listTopicPlans } from './topic-plan.js';

const incompleteRetrySchedule = new Map();

export async function notifyMetaEvents({ store, messenger, messengerFactory, timezone = 'America/Sao_Paulo' }) {
  const events = (store.pendingMetaNotices?.() || []).filter((event) => store.claimEventNotice(event.id));
  if (!events.length) return;
  const lines = events.map((event) => {
    const payload = JSON.parse(event.payload_json || '{}');
    const reference = store.approvalCode?.(event.post_id) || event.post_id;
    if (event.type === 'meta_schedule_confirmed') {
      const time = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(payload.scheduledAt));
      return `✅ Prévia #${reference}: agendamento confirmado na Meta para ${time}.`;
    }
    const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(payload.error || '') ? payload.error : 'META_SCHEDULE_UNCONFIRMED';
    return `⚠️ Prévia #${reference}: agendamento na Meta não confirmado (${code}). Não farei outro envio automaticamente.`;
  });
  let status;
  try { status = (await (messenger || messengerFactory()).send({ text: lines.join('\n') }))?.skipped ? 'skipped' : 'sent'; }
  catch { status = 'unconfirmed'; }
  for (const event of events) store.finishEventNotice(event.id, status);
}

export function localDay(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function dayOffset(day, offset) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function pastGenerationTime(date, timezone, generationTime = '08:00') {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(generationTime)) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const [targetHour, targetMinute] = generationTime.split(':').map(Number);
  return hour * 60 + minute >= targetHour * 60 + targetMinute;
}

export function aiReady(config) {
  return config.openclawAiEnabled === true || Boolean(config.aiFreeTierConfirmed === true && config.cfAccountId && config.cfApiToken);
}

export async function syncMetaInsights({ store, meta, config, now = new Date(), minIntervalMs = 6 * 60 * 60_000 }) {
  const latest = store.latestEvent?.('meta_insights_sync');
  if (latest?.created_at && now.getTime() - new Date(latest.created_at).getTime() < minIntervalMs) return { skipped: 'recent_sync' };
  const posts = store.publishedForInsights?.(100) || [];
  let synced = 0, viewsAvailable = 0, failed = 0, historicalSynced = 0, historicalFailed = 0;
  for (const post of posts) {
    try {
      const metrics = await meta.getPostPerformance({ postId: post.meta_post_id || post.meta_photo_id, pageToken: config.metaPageToken });
      store.savePostPerformance(post.id, metrics, now.toISOString());
      synced += 1;
      if (metrics.insightsAvailable) viewsAvailable += 1;
    } catch (error) {
      failed += 1;
      store.addEvent('meta_insights_post_failed', { postId: post.id, error: error.code || 'META_INSIGHTS_ERROR' });
    }
  }
  if (typeof meta.listPublishedPosts === 'function' && typeof store.saveHistoricalPerformance === 'function') {
    try {
      const historical = await meta.listPublishedPosts({ pageId: config.metaPageId, pageToken: config.metaPageToken, limit: 100 });
      for (const post of historical) {
        try {
          const metrics = await meta.getPostPerformance({ postId: post.id, pageToken: config.metaPageToken });
          store.saveHistoricalPerformance(post.id, post.message, post.createdTime, metrics, now.toISOString());
          historicalSynced += 1;
        } catch (error) {
          historicalFailed += 1;
          store.addEvent('meta_history_post_failed', { metaPostId: post.id, error: error.code || 'META_INSIGHTS_ERROR' });
        }
      }
    } catch (error) {
      historicalFailed += 1;
      store.addEvent('meta_history_sync_failed', { error: error.code || 'META_HISTORY_ERROR' });
    }
  }
  store.addEvent('meta_insights_sync', { synced, failed, total: posts.length, viewsAvailable, historicalSynced, historicalFailed });
  return { synced, failed, total: posts.length, viewsAvailable, historicalSynced, historicalFailed };
}

export async function workerTick({
  config, store, research, now = new Date(), makeAI = createAIProvider,
  makeMessenger = createOpenClawProvider, makeMeta = createMetaProvider,
  makeBatch = createDailyBatch, publish = publishDue, syncMeta = syncSchedulesWithMeta, syncInsights = syncMetaInsights, log = console.log,
  retryState = incompleteRetrySchedule,
  dispatchTask = startTask, listTasks = taskStatus, listPlans = listTopicPlans,
}) {
  const result = { publication: { skipped: 'publishing_disabled' }, insights: { skipped: 'meta_not_configured' }, generation: { skipped: 'generation_disabled' } };
  if (config.generationEnabled === true || config.metaPublishEnabled === true) result.expired = expireStalePosts({ store, config, now });
  const meta = config.metaPageToken ? makeMeta(config) : null;
  if (config.metaPublishEnabled === true) {
    try {
      const m = meta || makeMeta(config);
      result.sync = typeof m.listScheduledPosts === 'function'
        ? await syncMeta({ store, meta: m, config, now })
        : { skipped: 'meta_sync_unavailable' };
      result.publication = await publish({ store, meta: m, config, now });
    }
    catch (error) {
      result.publication = { error: error.code || 'META_ERROR' };
      log(JSON.stringify({ ...result.publication, message: error.message }));
    }
  }
  if (meta) {
    try { result.insights = await syncInsights({ store, meta, config, now }); }
    catch (error) {
      result.insights = { error: error.code || 'META_INSIGHTS_ERROR' };
      log(JSON.stringify({ ...result.insights, message: error.message }));
    }
  }
  if (config.metaPublishEnabled === true) await notifyMetaEvents({ store, messengerFactory: () => makeMessenger(config), timezone: config.timezone });
  // Enabling WhatsApp or authenticating a provider must not start daily AI work.
  // Only this separate explicit opt-in enables automatic generation.
  if (config.generationEnabled !== true) return result;
  if (!pastGenerationTime(now, config.timezone, config.generationTime)) {
    result.generation = { skipped: 'before_generation_time' };
    return result;
  }
  let topicPlans = [];
  if (makeBatch === createDailyBatch) {
    const tasks = await listTasks({ config });
    const active = tasks.find((task) => ['research', 'batch'].includes(task.command) && ['queued', 'running'].includes(task.status));
    if (active) { result.generation = { skipped: 'topic_task_active', jobId: active.id }; return result; }
    topicPlans = await listPlans({ config });
    const todayForPlans = localDay(now, config.timezone);
    const awaiting = topicPlans.find((plan) => plan.targetDay <= todayForPlans && ['pending', 'approved'].includes(plan.status));
    if (awaiting) {
      result.generation = { skipped: 'awaiting_topic_approval', planId: awaiting.id, targetDay: awaiting.targetDay };
      return result;
    }
    // Reconstruct backoff from persisted task completion after a worker restart.
    // The database remains the source of truth for coverage and approved posts.
    const seenDays = new Set();
    for (const task of tasks) {
      if (!['batch', 'research'].includes(task.command) || !task.targetDay || seenDays.has(task.targetDay)) continue;
      seenDays.add(task.targetDay);
      const summary = task.resultSummary;
      const incomplete = task.status !== 'completed' || summary?.blocked || summary?.remaining?.curiosity > 0 || summary?.remaining?.news > 0 || summary?.limited && !summary?.skipped;
      if (incomplete && task.finishedAt) {
        const finished = Date.parse(task.finishedAt);
        if (Number.isFinite(finished)) retryState.set(`day:${task.targetDay}`, finished + (config.researchRetryMinutes ?? 180) * 60_000);
      } else if (task.status === 'completed') retryState.delete(`day:${task.targetDay}`);
    }
  }
  store.recoverStaleGenerating?.(new Date(now.getTime() - 30 * 60_000).toISOString());
  const today = localDay(now, config.timezone);
  const horizon = Math.max(0, config.coverageDaysAhead ?? 0);
  const targetDays = Array.from({ length: horizon + 1 }, (_, index) => dayOffset(today, index));
  const coverage = targetDays.map((day) => store.dayCoverage?.(day) || { day, batchId: store.batchForDay(day)?.id || null, status: store.batchForDay(day)?.status || 'missing', total: store.batchForDay(day) ? 8 : 0, rejected: 0 });
  const targetDay = coverage.find((item) => {
    if (makeBatch === createDailyBatch && topicPlans.some((plan) => plan.targetDay === item.day && ['pending', 'approved'].includes(plan.status))) return false;
    const retryAt = Math.max(retryState.get(item.batchId) || 0, retryState.get(`day:${item.day}`) || 0);
    if (now.getTime() < retryAt) return false;
    if (item.status === 'missing') return true;
    const researchExhausted = String(item.warning || '').startsWith('Pesquisa incompleta');
    return (!researchExhausted || now.getTime() >= retryAt)
      && item.status !== 'generating'
      && ['blocked', 'pending_approval', 'scheduled'].includes(item.status)
      && (item.total < 8 || item.rejected > 0);
  })?.day;
  if (!targetDay) {
    result.generation = { skipped: 'coverage_complete', days: coverage };
    return result;
  }
  if (makeBatch !== createDailyBatch && !aiReady(config)) {
    result.generation = { skipped: 'ai_not_configured' };
    return result;
  }
  try {
    if (makeBatch === createDailyBatch) {
      result.generation = await dispatchTask({ config, command: 'research', args: ['--target-day', targetDay] });
      log(JSON.stringify({ worker: 'topic_research_dispatched', targetDay, ...result.generation }));
      return result;
    }
    result.generation = await makeBatch({ config, store, research, now, targetDay, ai: makeAI(config), messenger: makeMessenger(config), notifyProgress: false });
    if (result.generation.blocked === 'insufficient_topics' || result.generation.partial) {
      retryState.set(result.generation.batchId, now.getTime() + (config.researchRetryMinutes ?? 180) * 60_000);
    } else if (result.generation.batchId) retryState.delete(result.generation.batchId);
    log(JSON.stringify({ worker: result.generation.skipped ? 'batch_skipped' : 'batch_created', ...result.generation }));
  } catch (error) {
    result.generation = { error: error.code || 'BATCH_ERROR' };
    log(JSON.stringify({ ...result.generation, message: error.message }));
  }
  return result;
}

/** A fixed delay after completion, with a drainable current task for shutdown. */
export function createSerialLoop(task, { intervalMs = 60_000, onError = console.error } = {}) {
  if (typeof task !== 'function' || typeof onError !== 'function') throw new TypeError('Task and onError must be functions.');
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be positive.');
  let active = false;
  let timer = null;
  let current = null;

  function run() {
    current = Promise.resolve().then(task).catch(async (error) => {
      // A reporting failure must not become an unhandled timer rejection.
      try { await onError(error); } catch {}
    }).finally(() => {
      current = null;
      if (active) timer = setTimeout(() => { timer = null; run(); }, intervalMs);
    });
    return current;
  }

  return {
    start() {
      active = true;
      return current || (timer ? Promise.resolve() : run());
    },
    async stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await current;
    },
  };
}
