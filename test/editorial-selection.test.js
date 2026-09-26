import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorialSelector } from '../src/editorial-selection.js';

function candidates(count = 1) {
  return Array.from({ length: count }, (_, index) => ({ id: `topic-${index}`, topic: `Curiosidade ${index}`, summary: 'Um fato curioso para revisão.', category: 'curiosity', raw: { categoryHint: 'curiosity' }, sources: [{ id: `source-${index}`, url: `https://example.test/source-${index}`, title: 'Fonte de descoberta', text: 'Relato sobre o tema.', publishedAt: '2026-09-24T12:00:00Z' }] }));
}

function parseInput(prompt) { return JSON.parse(prompt.split('CANDIDATOS_JSON:\n')[1]); }
function decisions(input) { return input.map((candidate) => ({ id: candidate.id, eligible: true, category: 'curiosity', reason: 'Curiosidade natural concreta.' })); }

test('selector processes up to 20 candidates per sequential call and never changes original facts or URLs', async () => {
  const input = candidates(45);
  const original = structuredClone(input);
  const sizes = [];
  let active = 0, maximum = 0;
  const select = createEditorialSelector({ agent: 'editor-test', modelCall: async (prompt, options) => {
    active += 1;
    maximum = Math.max(maximum, active);
    const batch = parseInput(prompt);
    sizes.push(batch.length);
    assert.deepEqual(options, { label: 'research-select', agent: 'editor-test' });
    assert.ok(batch.every((item) => item.category === undefined && item.raw === undefined));
    await Promise.resolve();
    active -= 1;
    return { text: JSON.stringify({ decisions: decisions(batch).reverse() }) };
  } });
  const result = await select(input);
  assert.deepEqual(sizes, [20, 20, 5]);
  assert.equal(maximum, 1);
  assert.deepEqual(result.map((item) => item.id), input.map((item) => item.id));
  assert.deepEqual(input, original);
  assert.ok(result.every((item) => Object.keys(item).sort().join(',') === 'category,eligible,id,reason'));
});

test('a technology innovation discovered in a space query is news, while a GitHub issue is excluded', async () => {
  const input = candidates(3);
  input[0].topic = 'Google AI chips in space';
  input[1].topic = 'Bug in the GitHub space image client';
  input[1].sources[0].url = 'https://github.com/example/client/issues/42';
  input[2].topic = 'Animal que regenera órgãos';
  const select = createEditorialSelector({ modelCall: async (prompt) => {
    assert.match(prompt, /opinião pessoal/);
    assert.match(prompt, /política/);
    assert.match(prompt, /Não use ferramentas/);
    return { decisions: parseInput(prompt).map((item, index) => ({ id: item.id, eligible: true, category: index === 2 ? 'curiosity' : 'news', reason: 'Classificado pelo contexto do tópico.' })) };
  } });
  const result = await select(input);
  assert.equal(result[0].category, 'news');
  assert.equal(result[1].eligible, false);
  assert.match(result[1].reason, /GitHub/);
  assert.equal(result[2].category, 'curiosity');
  assert.equal(input[0].category, 'curiosity');
});

test('unknown, duplicate, missing IDs or invented candidate fields invalidate the entire model response', async () => {
  const input = candidates(2);
  const good = decisions(input);
  const variants = [
    [good[0], { ...good[1], id: 'invented' }],
    [good[0], good[0]],
    [good[0]],
    [...good, { ...good[0], id: 'extra' }],
    [{ ...good[0], eligible: 'true' }, good[1]],
    [{ ...good[0], category: 'politics' }, good[1]],
    [{ ...good[0], reason: '' }, good[1]],
    [{ ...good[0], url: 'https://invented.test' }, good[1]],
    [{ ...good[0], topic: 'Rewritten fact' }, good[1]],
  ];
  for (const variant of variants) {
    const select = createEditorialSelector({ modelCall: async () => ({ decisions: variant }) });
    await assert.rejects(select(input), { code: 'EDITORIAL_SELECTION_INVALID' });
  }
  await assert.rejects(createEditorialSelector({ modelCall: async () => 'not JSON' })(input), { code: 'EDITORIAL_SELECTION_INVALID' });
});

test('selector handles empty input without model work, and model failures expose only a safe error', async () => {
  const select = createEditorialSelector({ modelCall: async () => { throw new Error('private token and remote response'); } });
  assert.deepEqual(await select([]), []);
  await assert.rejects(select(candidates()), (error) => error.code === 'EDITORIAL_SELECTION_FAILED' && !error.message.includes('private'));
});
