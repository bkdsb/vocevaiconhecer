import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIProvider } from '../src/providers/ai.js';
import { createOpenClawAIProvider } from '../src/providers/openclaw-ai.js';

const cfg = { aiFreeTierConfirmed: true, cfAccountId: 'account', cfApiToken: 'token', textModel: '@cf/meta/llama-3.1-8b-instruct', imageModel: '@cf/black-forest-labs/flux-1-schnell' };
test('AI provider requires explicit free-tier acknowledgement and allowlisted models', () => { assert.throws(() => createAIProvider({ ...cfg, aiFreeTierConfirmed: false }), /AI_FREE_TIER_CONFIRMED/); assert.throws(() => createAIProvider({ ...cfg, imageModel: 'paid/model' }), /lista gratuita/); });
test('AI provider validates grounded copy and image output', async () => { const fetchImpl = async (_url, opts) => { const body = JSON.parse(opts.body); if (body.model.includes('flux')) return new Response(JSON.stringify({ success: true, result: { image: Buffer.alloc(128, 7).toString('base64') } })); return new Response(JSON.stringify({ success: true, result: { response: JSON.stringify({ headline: 'ANIMAL TESTE', highlights: ['TESTE'], caption: 'Fato comprovado. Imagem ilustrativa gerada por IA.', imagePrompt: 'a documentary animal', sourceIds: ['s1'], claims: [{ text: 'Fato', sourceIds: ['s1'] }] }) } })); }; const ai = createAIProvider(cfg, { fetchImpl }); const copy = await ai.generateCopy({ topic: 'Animal teste', sources: [{ id: 's1', url: 'https://example.test', title: 'Fonte' }] }); assert.equal(copy.sourceIds[0], 's1'); const image = await ai.generateImage({ prompt: copy.imagePrompt }); assert.ok(image.buffer.length > 5); });

test('OpenClaw/Codex provider accepts structured editor output and never shells through a command string', async () => {
  const calls = [];
  const execFileImpl = (bin, args, options, callback) => {
    calls.push({ bin, args, options });
    callback(null, JSON.stringify({ status: 'ok', result: { payloads: [{ text: JSON.stringify({ headline: 'PEIXE QUE ANDA', highlights: ['ANDA'], caption: 'Fato documentado. Imagem ilustrativa gerada por IA.', imagePrompt: 'a documentary fish', sourceIds: ['s1'], claims: [{ text: 'Fato documentado', sourceIds: ['s1'] }] }) }] } }), '');
  };
  const ai = createOpenClawAIProvider({ openclawAiEnabled: true, openclawBin: '/usr/bin/openclaw', openclawAiAgent: 'main', openclawAiModel: 'openai/gpt-5.6-sol' }, { execFileImpl });
  const copy = await ai.generateCopy({ topic: 'Peixe que anda', summary: 'evidência', sources: [{ id: 's1', url: 'https://example.test', title: 'Fonte' }] });
  assert.equal(copy.headline, 'PEIXE QUE ANDA');
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes('--model'));
});
