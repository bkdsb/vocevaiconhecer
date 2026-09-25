import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../src/db.js';
import { handleApprovalCommand, scheduleBatch } from '../src/workflow.js';

test('approval requires the post version and schedules the complete batch in São Paulo time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vvc-workflow-'));
  const db = await openDatabase(dir);
  const store = createStore(db);
  const batchId = 'batch_test';
  store.createBatch({ id: batchId, createdAt: '2026-09-24T10:00:00.000Z' });
  for (let slot = 1; slot <= 8; slot += 1) store.insertPost({ id: `batch_test_p${slot}`, batchId, slot, category: slot <= 4 ? 'curiosity' : 'news', topic: `teste-${slot}`, version: `abcdef${String(slot).padStart(2, '0')}34567890`, headline: 'Teste', caption: 'Teste', sources: [], trend: {}, status: 'pending_approval' });
  const config = { allowedSenders: ['+5511999999999'], approvalRequired: true, timezone: 'America/Sao_Paulo' };
  await assert.rejects(() => handleApprovalCommand({ text: 'APROVAR batch_test_p1 deadbeef', sender: '+5511999999999', config, store }), /Versão inválida/);
  for (let slot = 1; slot <= 7; slot += 1) await handleApprovalCommand({ text: `APROVAR batch_test_p${slot} abcdef${String(slot).padStart(2, '0')}`, sender: '+5511999999999', config, store });
  const result = await handleApprovalCommand({ text: 'APROVAR batch_test_p8 abcdef08', sender: '+5511999999999', config, store, now: new Date('2026-09-24T14:00:00.000Z') });
  assert.match(result.text, /agendados/);
  const post = store.getPost('batch_test_p1');
  assert.equal(post.status, 'scheduled');
  // Approval happened after the first two daily slots; late approvals are
  // moved forward instead of publishing a burst retroactively.
  assert.match(post.scheduled_at, /T12:18:00-03:00$/);
  store.close();
});

test('pause blocks a scheduled batch and resume moves approved posts to future slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vvc-pause-'));
  const db = await openDatabase(dir);
  const store = createStore(db);
  const batchId = 'batch_pause';
  store.createBatch({ id: batchId, createdAt: '2026-09-24T10:00:00.000Z' });
  for (let slot = 1; slot <= 8; slot += 1) store.insertPost({ id: `batch_pause_p${slot}`, batchId, slot, category: slot <= 4 ? 'curiosity' : 'news', topic: `pause-${slot}`, version: `abcdef${String(slot).padStart(2, '0')}34567890`, headline: 'Teste', caption: 'Teste', sources: [], trend: {}, status: 'pending_approval' });
  for (let slot = 1; slot <= 8; slot += 1) store.approvePost(`batch_pause_p${slot}`, '2026-09-24T10:00:00.000Z');
  const config = { allowedSenders: ['+5511999999999'], approvalRequired: true, timezone: 'America/Sao_Paulo' };
  const scheduled = scheduleBatch({ store, config, batchId, now: new Date('2026-09-24T14:00:00.000Z') });
  assert.equal(scheduled.scheduled, true);
  const paused = await handleApprovalCommand({ text: `PAUSAR ${batchId}`, sender: '+5511999999999', config, store, now: new Date('2026-09-24T15:00:00.000Z') });
  assert.match(paused.text, /pausado/);
  const resumed = await handleApprovalCommand({ text: `RETOMAR ${batchId}`, sender: '+5511999999999', config, store, now: new Date('2026-09-24T15:00:00.000Z') });
  assert.match(resumed.text, /retomado/);
  assert.equal(store.getBatch(batchId).status, 'scheduled');
  assert.ok(new Date(store.getPost('batch_pause_p1').scheduled_at) > new Date('2026-09-24T15:00:00.000Z'));
  store.close();
});
