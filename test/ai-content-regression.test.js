import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCopy } from '../src/providers/ai-content.js';

test('missing or malformed AI headline fails with COPY_INVALID instead of a JavaScript crash', () => {
  const candidate = { sources: [{ id: 'source1', url: 'https://example.com/story' }] };
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  for (const headline of [undefined, null, 42, {}, '', '   ']) {
    const copy = { headline, highlights: ['Título'], caption: 'Texto.', imagePrompt: 'A photo', sourceIds: ['source1'], claims: [{ text: 'Texto.', sourceIds: ['source1'] }] };
    assert.throws(() => validateCopy(copy, candidate, fail), { code: 'COPY_INVALID' });
  }
});
