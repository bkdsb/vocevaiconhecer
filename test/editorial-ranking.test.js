import test from 'node:test';
import assert from 'node:assert/strict';
import { select, createDailyBatch } from '../src/workflow.js';

test('final batch selection retains Facebook priority over a stronger generic hook', () => {
  const facebook = { id: 'fb', topic: 'Uma curiosidade sobre tartarugas', category: 'curiosity', publishable: true, sources: [], raw: { inspirationKind: 'facebook' } };
  const generic = { id: 'web', topic: 'Incrível descoberta recorde viral', category: 'curiosity', publishable: true, sources: [], trend: { aggregateMetrics: { likes: 1000000 } }, raw: {} };
  assert.equal(select([generic, facebook], 'curiosity', 1, 'seed')[0].id, 'fb');
  assert.equal(select([{ ...facebook, publishable: false }, generic], 'curiosity', 1, 'seed')[0].id, 'web');
});

test('requiring topic approval stops before any research, database or image generation', async () => {
  await assert.rejects(createDailyBatch({ config: { topicApprovalRequired: true }, store: { batchForDay() { assert.fail('database must not be touched'); } }, ai: { generateImage() { assert.fail('must not generate'); } } }), { code: 'TOPIC_APPROVAL_REQUIRED' });
});
