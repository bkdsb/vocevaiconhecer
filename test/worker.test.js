import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { aiReady, createSerialLoop, localDay, pastGenerationTime, workerTick } from '../src/worker.js';

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
    assert.deepEqual(result.generation, { batchId: 'reserved', skipped: 'already_created_today' });
  }
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
      days.set(localDay(now, config.timezone), { id: 'generated', status: 'pending_approval' });
      return { batchId: 'generated', selected: 8 };
    },
  };
  assert.equal((await workerTick(options)).generation.selected, 8);
  assert.equal((await workerTick(options)).generation.skipped, 'already_created_today');
  assert.equal(calls, 1);
  assert.equal(logs[0].worker, 'batch_created');
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
