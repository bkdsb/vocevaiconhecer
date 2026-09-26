import { createAIProvider } from './providers/ai.js';
import { createOpenClawProvider } from './providers/openclaw.js';
import { createMetaProvider } from './providers/meta.js';
import { createDailyBatch, publishDue } from './workflow.js';

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

export async function workerTick({
  config, store, research, now = new Date(), makeAI = createAIProvider,
  makeMessenger = createOpenClawProvider, makeMeta = createMetaProvider,
  makeBatch = createDailyBatch, publish = publishDue, log = console.log,
}) {
  const result = { publication: { skipped: 'publishing_disabled' }, generation: { skipped: 'generation_disabled' } };
  if (config.metaPublishEnabled === true) {
    try { result.publication = await publish({ store, meta: makeMeta(config), config, now }); }
    catch (error) {
      result.publication = { error: error.code || 'META_ERROR' };
      log(JSON.stringify({ ...result.publication, message: error.message }));
    }
  }
  // Enabling WhatsApp or authenticating a provider must not start daily AI work.
  // Only this separate explicit opt-in enables automatic generation.
  if (config.generationEnabled !== true) return result;
  if (!pastGenerationTime(now, config.timezone, config.generationTime)) {
    result.generation = { skipped: 'before_generation_time' };
    return result;
  }
  const today = localDay(now, config.timezone);
  const horizon = Math.max(0, config.coverageDaysAhead ?? 0);
  const targetDays = Array.from({ length: horizon + 1 }, (_, index) => dayOffset(today, index));
  const coverage = targetDays.map((day) => store.dayCoverage?.(day) || { day, batchId: store.batchForDay(day)?.id || null, status: store.batchForDay(day)?.status || 'missing', total: store.batchForDay(day) ? 8 : 0, rejected: 0 });
  const targetDay = coverage.find((item) => item.status === 'missing'
    || item.status !== 'generating' && ['blocked', 'pending_approval', 'scheduled'].includes(item.status) && (item.total < 8 || item.rejected > 0))?.day;
  if (!targetDay) {
    result.generation = { skipped: 'coverage_complete', days: coverage };
    return result;
  }
  if (!aiReady(config)) {
    result.generation = { skipped: 'ai_not_configured' };
    return result;
  }
  try {
    result.generation = await makeBatch({ config, store, research, now, targetDay, ai: makeAI(config), messenger: makeMessenger(config) });
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
