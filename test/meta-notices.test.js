import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../src/db.js';
import { notifyMetaEvents } from '../src/worker.js';

test('native scheduling notices persist an ambiguous delivery and are not resent after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vvc-meta-notices-'));
  let store = createStore(await openDatabase(dir));
  t.after(async () => { store.close(); await rm(dir, { recursive: true }); });
  store.addEvent('meta_schedule_unconfirmed', { postId: 'preview', error: 'META_SCHEDULE_UNCONFIRMED' });
  let sends = 0;
  const messenger = { send: async ({ text }) => { sends++; assert.match(text, /não confirmado/); throw new Error('ambiguous'); } };
  await notifyMetaEvents({ store, messenger });
  store.close(); store = createStore(await openDatabase(dir));
  await notifyMetaEvents({ store, messenger });
  assert.equal(sends, 1);
  assert.equal(store.pendingMetaNotices().length, 0);
  store.addEvent('meta_schedule_confirmed', { postId: 'preview', scheduledAt: '2026-10-05T18:00:00-03:00' });
  await notifyMetaEvents({ store, messenger: { send: async ({ text }) => { assert.match(text, /confirmado na Meta/); return { sent: true }; } } });
  assert.equal(store.pendingMetaNotices().length, 0);
});
