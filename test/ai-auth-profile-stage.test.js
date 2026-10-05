import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProviderKeys, profileImportPlan } from '../scripts/stage-ai-auth-profiles.mjs';

test('import staging deduplicates credentials and reports no credential material', () => {
  const google = `AIza${'g'.repeat(32)}`, groq = `gsk_${'r'.repeat(40)}`, router = `sk-or-v1-${'a'.repeat(64)}`;
  const keys = extractProviderKeys(`${google}\n${groq}\n${router}\n${google}`);
  assert.deepEqual(Object.values(keys).map((values) => values.length), [1, 1, 1]);
  const plan = profileImportPlan(keys, ['main', 'vvc-editor']); const rendered = JSON.stringify(plan);
  assert.doesNotMatch(rendered, /AIza|gsk_|sk-or-v1-/); assert.equal(plan.providers.groq.profileIds[0], 'groq:vvc-key-01');
  assert.match(plan.quotaPolicy, /compartilhadas/);
});

test('each credential receives a distinct provider profile without replacing manual profile', () => {
  const plan = profileImportPlan({ groq: ['one', 'two', 'three'] }, ['main']);
  assert.equal(new Set(plan.providers.groq.profileIds).size, 3);
  assert.ok(plan.providers.groq.profileIds.every((id) => id !== 'groq:manual'));
  assert.throws(() => profileImportPlan({ groq: [] }, ['../bad']));
});
