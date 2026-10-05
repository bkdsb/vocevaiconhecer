import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { monitorTask, taskStatus, sanitizeTaskOutput, summarizeTaskResult, parseTaskArguments } from '../src/task-runner.js';

function harness({ failedSend = false, deadlineMs = 900_000, stallMs = 480_000 } = {}) {
  const child = new EventEmitter(); child.pid = 123; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let time = 0; let tick; let killed = 0; let cleared = 0; const sent = []; const saved = [];
  const state = { id: '83e201a9-80a4-4bb9-b292-ac6812901b02', command: 'research', deadlineMs, stallMs, progressMs: 60_000, notices: [] };
  return { child, sent, saved, state, setTime: (value) => { time = value; }, tick: () => tick(), kills: () => killed, clears: () => cleared,
    options: { state, child, now: () => time, persist: async (value) => saved.push(JSON.parse(JSON.stringify(value))), send: async ({ text }) => { sent.push(text); if (failedSend) throw Object.assign(new Error('ambiguous'), { code: 'OPENCLAW_UNKNOWN' }); return { sent: true }; },
      setIntervalImpl: (fn) => { tick = fn; return 1; }, clearIntervalImpl: () => { cleared++; }, killChild: () => { killed++; } } };
}

test('supervisor sends start, real elapsed status and terminal completion', async () => {
  const h = harness(); const monitor = await monitorTask(h.options); await monitor.flush();
  h.setTime(60_000); h.tick(); await monitor.flush();
  h.child.emit('close', 0, null); const final = await monitor.done;
  assert.equal(final.status, 'completed'); assert.equal(h.sent.length, 3);
  assert.match(h.sent[1], /ainda está executando/); assert.match(h.sent[2], /concluída/);
  assert.equal(h.kills(), 0); assert.equal(h.clears(), 1);
  h.tick(); await monitor.flush(); assert.equal(h.sent.length, 3);
});

test('exit 1 always produces final failed status instead of a promise to investigate', async () => {
  const h = harness(); const monitor = await monitorTask(h.options); await monitor.flush();
  h.child.stderr.emit('data', 'bad input token=private-secret'); h.child.emit('close', 1, null);
  const final = await monitor.done; assert.equal(final.errorCode, 'EXIT_1'); assert.equal(final.status, 'failed');
  assert.match(h.sent.at(-1), /terminou com erro/); assert.doesNotMatch(final.outputTail, /private-secret/);
});

test('uncertain message delivery is recorded once and never retried', async () => {
  const h = harness({ failedSend: true }); const monitor = await monitorTask(h.options); await monitor.flush();
  h.child.emit('close', 0, null); await monitor.done;
  assert.equal(h.sent.length, 2); assert.deepEqual(h.state.notices.map((notice) => notice.delivery), ['unconfirmed', 'unconfirmed']);
  assert.equal(h.saved[0].status, 'running');
});

test('deadline and inactivity stop only the owned child and send terminal reason once', async () => {
  for (const [deadlineMs, stallMs, expected] of [[120_000, 300_000, 'timed_out'], [300_000, 120_000, 'stalled']]) {
    const h = harness({ deadlineMs, stallMs }); const monitor = await monitorTask(h.options); await monitor.flush();
    h.setTime(120_000); h.tick(); const final = await monitor.done;
    assert.equal(final.status, expected); assert.equal(h.kills(), 1); assert.match(h.sent.at(-1), /interrompida/);
    h.child.emit('close', null, 'SIGKILL'); await monitor.flush(); assert.equal(h.sent.length, 2);
  }
});

test('supervisor shutdown records interruption and terminal notification', async () => {
  const h = harness(); const monitor = await monitorTask(h.options); await monitor.flush(); monitor.interrupted();
  assert.equal((await monitor.done).status, 'interrupted'); assert.equal(h.kills(), 1); assert.match(h.sent.at(-1), /encerramento/);
});

test('state write failure does not suppress the final WhatsApp notice or hang monitor', async () => {
  const h = harness(); h.options.persist = async () => { throw new Error('disk unavailable'); };
  const monitor = await monitorTask(h.options); await monitor.flush(); h.child.emit('close', 1, null);
  const result = await monitor.done; assert.equal(result.status, 'failed'); assert.equal(result.persistenceError, 'TASK_STATE_WRITE');
  assert.equal(h.sent.length, 2); assert.match(h.sent.at(-1), /terminou com erro/);
});

test('task-status detects supervisor lost on restart and notifies once', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'vvc-task-test-')); const id = '83e201a9-80a4-4bb9-b292-ac6812901b02';
  const config = { dataDir }; const messages = []; const messenger = { send: async (message) => { messages.push(message.text); return { sent: true }; } };
  try {
    await mkdir(resolve(dataDir, 'tasks')); await writeFile(resolve(dataDir, 'tasks', `${id}.json`), JSON.stringify({ id, command: 'research', status: 'running', supervisorPid: 999, createdAt: '2000-01-01T00:00:00Z', notices: [] }));
    const result = await taskStatus({ config, id, messenger, isAlive: () => false });
    assert.equal(result[0].status, 'interrupted'); assert.equal(result[0].errorCode, 'TASK_SUPERVISOR_LOST'); assert.equal(messages.length, 1);
    await taskStatus({ config, id, messenger, isAlive: () => false }); assert.equal(messages.length, 1);
    const stored = JSON.parse(await readFile(resolve(dataDir, 'tasks', `${id}.json`), 'utf8')); assert.equal(stored.notices[0].delivery, 'sent');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('output sanitizer removes credential formats and secret fields', () => {
  const output = sanitizeTaskOutput('AIzaTest12345 gsk_example sk-or-v1-abcd AQ.example EAAabcdefghijklmnopqrstuvwxyz token=example password:"abcd"');
  assert.doesNotMatch(output, /AIzaTest|gsk_example|sk-or-v1|AQ.example|EAAabc|=example|abcd/);
});

test('research summary exposes only counts and safe warning codes and explains empty outcome', () => {
  const result = summarizeTaskResult('research', JSON.stringify({ counts: { retained: 0, verified: { curiosity: 0, news: 0 } }, warnings: [{ code: 'INSUFFICIENT_NEWS', message: 'token=secret' }, { code: 'AIzaSECRET' }], token: 'secret' }));
  assert.equal(result.limited, true); assert.equal(result.verified, 0); assert.match(result.text, /Nenhuma pauta/); assert.match(result.text, /Menos notícias validadas do que o ideal/);
  assert.doesNotMatch(result.text, /secret|AIza/);
});

test('batch summary explains blocked and skipped execution with remaining counts', () => {
  const blocked = summarizeTaskResult('batch', JSON.stringify({ selected: 0, blocked: 'insufficient_topics', remaining: { curiosity: 2, news: 4 } }));
  assert.equal(blocked.limited, true); assert.match(blocked.text, /falta de pautas suficientes/); assert.match(blocked.text, /2 curiosidades e 4 notícias/);
  const skipped = summarizeTaskResult('batch', JSON.stringify({ skipped: 'already_created_today' }));
  assert.match(skipped.text, /já existe um para o dia/);
});

test('research summary announces themes awaiting approval before any images', () => {
  const result = summarizeTaskResult('research', JSON.stringify({ counts: { retained: 14, verified: { curiosity: 6, news: 6 } }, planId: '1234abcd', topicCount: 8 }));
  assert.match(result.text, /8 temas aguardando sua aprovação/); assert.match(result.text, /imagens ainda não foram geradas/);
  assert.equal(result.planId, '1234abcd'); assert.equal(result.topicCount, 8);
});

test('successful child notification contains the actual research result', async () => {
  const h = harness(); const monitor = await monitorTask(h.options); await monitor.flush();
  h.child.stdout.emit('data', JSON.stringify({ counts: { retained: 7, verified: { curiosity: 3, news: 2 } }, warnings: [] }));
  h.child.emit('close', 0, null); await monitor.done;
  assert.match(h.sent.at(-1), /Vasculhamos 7 links e filtramos 5 úteis/); assert.equal(h.state.resultSummary.limited, false);
});

test('child deadline kills immediately even while the WhatsApp send is hanging', async () => {
  const h = harness({ deadlineMs: 120_000, stallMs: 300_000 }); h.options.send = () => new Promise(() => {}); h.options.sendTimeoutMs = 10;
  const monitor = await monitorTask(h.options);
  h.setTime(120_000); h.tick(); assert.equal(h.kills(), 1);
  const final = await monitor.done; assert.equal(final.status, 'timed_out');
  assert.equal(final.notices.length, 2); assert.ok(final.notices.every((notice) => notice.delivery === 'unconfirmed'));
});

test('real child progress output prevents an inactivity interruption', async () => {
  const h = harness({ deadlineMs: 600_000, stallMs: 120_000 }); const monitor = await monitorTask(h.options); await monitor.flush();
  h.setTime(110_000); h.child.stderr.emit('data', '{"taskProgress":{"type":"research_finished"}}\n');
  h.setTime(180_000); h.tick(); await monitor.flush(); assert.equal(h.kills(), 0);
  h.child.emit('close', 0, null); await monitor.done;
});

test('task target day accepts a real calendar day and rejects malformed or impossible dates', () => {
  assert.deepEqual(parseTaskArguments('batch', ['--plan-id', '1234abcd', '--target-day', '2026-10-04']), { planId: '1234abcd', targetDay: '2026-10-04' });
  assert.deepEqual(parseTaskArguments('research', ['--discover-only', '--target-day', '2026-10-04']), { discoverOnly: true, targetDay: '2026-10-04' });
  for (const args of [['--target-day', '2026-02-30'], ['--target-day', 'tomorrow'], ['--target-day', '2026-10-04', '--send'], ['--discover-only'], [], ['--plan-id', '../escape']]) assert.throws(() => parseTaskArguments('batch', args));
  assert.throws(() => parseTaskArguments('research', ['--target-day', '2026-02-30']));
  assert.throws(() => parseTaskArguments('research', ['--plan-id', '1234abcd']));
});

test('structured image quota failure reports awaiting quota and preserves approved themes', async () => {
  const h = harness(); h.state.command = 'batch'; const monitor = await monitorTask(h.options); await monitor.flush();
  h.child.stderr.emit('data', JSON.stringify({ error: 'AI_IMAGE_FREE_UNAVAILABLE', message: 'private-detail' }) + '\n');
  h.child.emit('close', 1, null); const final = await monitor.done;
  assert.equal(final.status, 'awaiting_quota'); assert.equal(final.errorCode, 'AI_IMAGE_FREE_UNAVAILABLE');
  assert.match(h.sent.at(-1), /aguardando a liberação/); assert.match(h.sent.at(-1), /temas aprovados foram preservados/);
  assert.doesNotMatch(h.sent.at(-1), /private-detail/);
});
