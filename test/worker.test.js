import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { aiReady, createSerialLoop, localDay, pastGenerationTime, syncMetaInsights, workerTick } from '../src/worker.js';

const config = { timezone: 'America/Sao_Paulo', generationTime: '08:00', openclawAiEnabled: true, metaPublishEnabled: false };
const now = new Date('2026-09-25T12:00:00Z');
const never = () => assert.fail('dependency must not be invoked');

test('automatic generation is opt-in and does not construct AI or messenger providers by default', async () => {
  for (const generationEnabled of [undefined, false, 'true', 1]) {
    const result = await workerTick({
      config: { ...config, generationEnabled }, store: { batchForDay: never }, now,
      makeAI: never, makeMessenger: never, makeMeta: never, makeBatch: never, log: never,
    });
    assert.equal(result.generation.skipped, 'generation_disabled');
  }
});

test('local generation day and hour use São Paulo timezone, including midnight boundary', () => {
  assert.equal(localDay(new Date('2026-09-25T01:00:00Z'), config.timezone), '2026-09-24');
  assert.equal(pastGenerationTime(new Date('2026-09-25T10:59:59Z'), config.timezone, '08:00'), false);
  assert.equal(pastGenerationTime(new Date('2026-09-25T11:00:00Z'), config.timezone, '08:00'), true);
  assert.equal(pastGenerationTime(now, config.timezone, '25:99'), false);
  assert.equal(aiReady({ openclawAiEnabled: false, cfAccountId: 'id', cfApiToken: 'token' }), false);
});

test('worker respects generation time and configured AI before starting any generation', async () => {
  const makeAI = never;
  const options = { config: { ...config, generationEnabled: true }, store: { batchForDay: () => null }, makeAI, makeBatch: never, log: never };
  assert.equal((await workerTick({ ...options, now: new Date('2026-09-25T10:00:00Z') })).generation.skipped, 'before_generation_time');
  assert.equal((await workerTick({ ...options, config: { ...options.config, openclawAiEnabled: false }, now })).generation.skipped, 'ai_not_configured');
});

test('worker uses the persisted day reservation, including failed days, rather than latestBatch', async () => {
  for (const status of ['generating', 'blocked', 'pending_approval', 'scheduled']) {
    const result = await workerTick({
      config: { ...config, generationEnabled: true }, now,
      store: { latestBatch: never, batchForDay: (day) => { assert.equal(day, '2026-09-25'); return { id: 'reserved', status }; } },
      makeAI: never, makeBatch: never, log: never,
    });
    assert.equal(result.generation.skipped, 'coverage_complete');
  }
});

test('worker does not retry an exhausted incomplete research pass every tick', async () => {
  const retryState = new Map([['reserved', now.getTime() + 60_000]]);
  const result = await workerTick({
    config: { ...config, generationEnabled: true }, now,
    store: { dayCoverage: (day) => ({ day, batchId: 'reserved', status: 'blocked', total: 5, rejected: 3, warning: 'Pesquisa incompleta no last30days: faltam pautas.' }), batchForDay: never },
    retryState, makeAI: never, makeBatch: never, log: never,
  });
  assert.equal(result.generation.skipped, 'coverage_complete');
});

test('worker retries incomplete research after backoff and schedules the next retry when still partial', async () => {
  const retryState = new Map([['reserved', now.getTime() - 1]]);
  const result = await workerTick({
    config: { ...config, generationEnabled: true, researchRetryMinutes: 90 }, now, retryState,
    store: { dayCoverage: (day) => ({ day, batchId: 'reserved', status: 'blocked', total: 5, rejected: 3, warning: 'Pesquisa incompleta no last30days: faltam pautas.' }), batchForDay: never },
    makeAI: () => ({}), makeMessenger: () => ({}), log: () => {},
    makeBatch: async () => ({ batchId: 'reserved', selected: 2, partial: true }),
  });
  assert.equal(result.generation.selected, 2);
  assert.equal(retryState.get('reserved'), now.getTime() + 90 * 60_000);
});

test('enabled worker generates once, passes research dependency, and skips a subsequent tick', async () => {
  const days = new Map();
  const store = { batchForDay: (day) => days.get(day), latestBatch: never };
  const research = () => {};
  const ai = {}, messenger = {}, logs = [];
  let calls = 0;
  const options = {
    config: { ...config, generationEnabled: true }, store, research, now,
    makeAI: () => ai, makeMessenger: () => messenger, log: (value) => logs.push(JSON.parse(value)),
    makeBatch: async (args) => {
      calls += 1;
      assert.equal(args.research, research);
      assert.equal(args.ai, ai);
      assert.equal(args.messenger, messenger);
      assert.equal(args.now, now);
      assert.equal(args.targetDay, localDay(now, config.timezone));
      days.set(args.targetDay, { id: 'generated', status: 'pending_approval' });
      return { batchId: 'generated', selected: 8 };
    },
  };
  assert.equal((await workerTick(options)).generation.selected, 8);
  assert.equal((await workerTick(options)).generation.skipped, 'coverage_complete');
  assert.equal(calls, 1);
  assert.equal(logs[0].worker, 'batch_created');
});

test('insights sync stores local and historical Page performance and rate-limits itself', async () => {
  const saved = [], historical = [], events = [];
  const store = {
    latestEvent: () => null,
    publishedForInsights: () => [{ id: 'p1', meta_post_id: '123_456' }],
    savePostPerformance: (id, metrics) => saved.push([id, metrics]),
    saveHistoricalPerformance: (...args) => historical.push(args),
    addEvent: (type, payload) => events.push([type, payload]),
  };
  const meta = {
    listPublishedPosts: async () => [{ id: '123_old', message: 'Polvo azul raro no oceano', createdTime: '2025-01-01T00:00:00Z' }],
    getPostPerformance: async () => ({ mediaViews: 1000, uniqueViews: 700, reactions: 40, comments: 9, shares: 5, insightsAvailable: true }),
  };
  const first = await syncMetaInsights({ store, meta, config: { metaPageId: '123', metaPageToken: 'x' }, now });
  assert.equal(first.synced, 1);
  assert.equal(first.historicalSynced, 1);
  assert.equal(saved.length, 1);
  assert.equal(historical[0][0], '123_old');
  assert.ok(events.some(([type]) => type === 'meta_insights_sync'));
  store.latestEvent = () => ({ created_at: now.toISOString() });
  assert.equal((await syncMetaInsights({ store, meta, config: { metaPageId: '123', metaPageToken: 'x' }, now })).skipped, 'recent_sync');
});

test('publishing already approved posts is independent of automatic generation opt-in', async () => {
  const meta = {};
  let sends = 0;
  const result = await workerTick({
    config: { ...config, metaPublishEnabled: true, generationEnabled: false }, store: { batchForDay: never }, now,
    makeAI: never, makeBatch: never, makeMeta: () => meta,
    publish: async (args) => { assert.equal(args.meta, meta); sends += 1; return { published: 1 }; },
    log: never,
  });
  assert.equal(sends, 1);
  assert.equal(result.publication.published, 1);
  assert.equal(result.generation.skipped, 'generation_disabled');
});

test('default generation dispatches only topic research for the first uncovered day without constructing AI providers', async () => {
  const calls = [];
  const result = await workerTick({
    config: { ...config, generationEnabled: true, coverageDaysAhead: 1 }, now,
    store: { dayCoverage: (day) => ({ day, status: day === '2026-09-25' ? 'scheduled' : 'missing', total: day === '2026-09-25' ? 8 : 0, rejected: 0 }) },
    makeAI: never, makeMessenger: never, retryState: new Map(), listTasks: async () => [], listPlans: async () => [],
    dispatchTask: async (args) => { calls.push(args); return { jobId: 'job1', status: 'queued' }; }, log: () => {},
  });
  assert.equal(result.generation.jobId, 'job1'); assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'research'); assert.deepEqual(calls[0].args, ['--target-day', '2026-09-26']);
});

test('an active supervised batch skips generation while the worker continues publication', async () => {
  let publications = 0;
  const result = await workerTick({
    config: { ...config, generationEnabled: true, metaPublishEnabled: true }, now,
    store: { recoverStaleGenerating: never, dayCoverage: never },
    makeMeta: () => ({}), publish: async () => { publications++; return { published: 1 }; },
    makeAI: never, makeMessenger: never, dispatchTask: never,
    listTasks: async () => [{ id: 'running-job', command: 'batch', status: 'running' }], log: () => {},
  });
  assert.equal(publications, 1); assert.equal(result.generation.skipped, 'topic_task_active'); assert.equal(result.generation.jobId, 'running-job');
});

test('persisted partial batch result restores retry delay after restart and then retries safely', async () => {
  const retryState = new Map(); let dispatched = 0;
  const options = {
    config: { ...config, generationEnabled: true, researchRetryMinutes: 90 }, now,
    store: { dayCoverage: (day) => ({ day, batchId: 'reserved', status: 'blocked', total: 5, rejected: 0, warning: 'Pesquisa incompleta' }) },
    retryState, makeAI: never, makeMessenger: never, listPlans: async () => [],
    listTasks: async () => [{ id: 'done', command: 'batch', targetDay: '2026-09-25', status: 'completed', finishedAt: now.toISOString(), resultSummary: { limited: true, remaining: { curiosity: 1, news: 2 } } }],
    dispatchTask: async () => { dispatched++; return { jobId: 'retry', status: 'queued' }; }, log: () => {},
  };
  assert.equal((await workerTick(options)).generation.skipped, 'coverage_complete'); assert.equal(dispatched, 0);
  assert.equal(retryState.get('day:2026-09-25'), now.getTime() + 90 * 60_000);
  const retried = await workerTick({ ...options, now: new Date(now.getTime() + 91 * 60_000) });
  assert.equal(retried.generation.jobId, 'retry'); assert.equal(dispatched, 1);
});

test('failed task before database reservation backs off the missing day instead of respawning each tick', async () => {
  const result = await workerTick({
    config: { ...config, generationEnabled: true }, now, retryState: new Map(),
    store: { dayCoverage: (day) => ({ day, status: 'missing', total: 0, rejected: 0 }) },
    listTasks: async () => [{ id: 'failed', command: 'research', targetDay: '2026-09-25', status: 'failed', finishedAt: now.toISOString() }], listPlans: async () => [],
    dispatchTask: never, makeAI: never, makeMessenger: never, log: () => {},
  });
  assert.equal(result.generation.skipped, 'coverage_complete');
});

test('pending or approved topic plans prevent repeating research and never trigger automatic images', async () => {
  for (const status of ['pending', 'approved']) {
    const result = await workerTick({
      config: { ...config, generationEnabled: true }, now, retryState: new Map(),
      store: { dayCoverage: (day) => ({ day, status: 'missing', total: 0, rejected: 0 }) },
      listTasks: async () => [], listPlans: async () => [{ id: '1234abcd', targetDay: '2026-09-25', status }],
      dispatchTask: never, makeAI: never, makeMessenger: never, log: () => {},
    });
    assert.equal(result.generation.skipped, 'awaiting_topic_approval');
  }
});

test('an awaiting plan today or earlier prevents researching tomorrow before filling today', async () => {
  for (const targetDay of ['2026-09-24', '2026-09-25']) {
    const result = await workerTick({
      config: { ...config, generationEnabled: true, coverageDaysAhead: 2 }, now, retryState: new Map(),
      store: { dayCoverage: (day) => ({ day, status: 'missing', total: 0, rejected: 0 }) },
      listTasks: async () => [], listPlans: async () => [{ id: '1234abcd', targetDay, status: 'pending' }],
      dispatchTask: never, makeAI: never, makeMessenger: never, log: () => {},
    });
    assert.equal(result.generation.skipped, 'awaiting_topic_approval'); assert.equal(result.generation.targetDay, targetDay);
  }
});

test('consumed partial plan releases today for researching missing topics before tomorrow', async () => {
  const result = await workerTick({
    config: { ...config, generationEnabled: true, coverageDaysAhead: 2 }, now, retryState: new Map(),
    store: { dayCoverage: (day) => ({ day, status: day === '2026-09-25' ? 'pending_approval' : 'missing', total: day === '2026-09-25' ? 3 : 0, rejected: 0 }) },
    listTasks: async () => [], listPlans: async () => [{ id: '1234abcd', targetDay: '2026-09-25', status: 'consumed' }],
    dispatchTask: async ({ command, args }) => { assert.equal(command, 'research'); assert.deepEqual(args, ['--target-day', '2026-09-25']); return { jobId: 'today-repair', status: 'queued' }; },
    makeAI: never, makeMessenger: never, log: () => {},
  });
  assert.equal(result.generation.jobId, 'today-repair');
});

test('automatic topic research can run without any image or text AI configured', async () => {
  const result = await workerTick({
    config: { ...config, generationEnabled: true, openclawAiEnabled: false }, now, retryState: new Map(),
    store: { dayCoverage: (day) => ({ day, status: 'missing', total: 0, rejected: 0 }) },
    listTasks: async () => [], listPlans: async () => [],
    dispatchTask: async ({ command }) => { assert.equal(command, 'research'); return { jobId: 'research-only', status: 'queued' }; },
    makeAI: never, makeMessenger: never, log: () => {},
  });
  assert.equal(result.generation.jobId, 'research-only');
});

test('serial loop does not overlap long ticks and stop waits for current task', async () => {
  let release, entered, count = 0, stopped = false;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const loop = createSerialLoop(async () => { count += 1; entered(); await gate; }, { intervalMs: 5, onError: never });
  loop.start();
  loop.start();
  await started;
  await delay(25);
  assert.equal(count, 1);
  const stop = loop.stop().then(() => { stopped = true; });
  await delay(5);
  assert.equal(stopped, false);
  release();
  await stop;
  assert.equal(stopped, true);
  await delay(20);
  assert.equal(count, 1);
});

test('serial loop reports failures, runs again after completion, and cancels future ticks on stop', async () => {
  const errors = [];
  let count = 0, second;
  const reachedSecond = new Promise((resolve) => { second = resolve; });
  const failure = new Error('test failure');
  const loop = createSerialLoop(async () => {
    count += 1;
    if (count === 1) throw failure;
    second();
  }, { intervalMs: 5, onError: (error) => errors.push(error) });
  await loop.start();
  await reachedSecond;
  await loop.stop();
  const stoppedCount = count;
  await delay(20);
  assert.equal(count, stoppedCount);
  assert.equal(count, 2);
  assert.deepEqual(errors, [failure]);
});
