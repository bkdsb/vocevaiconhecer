import { randomUUID } from 'node:crypto';
import { createOpenClawAIProvider } from './openclaw-ai.js';
import { copyPrompt, decodeImageBase64, validateCandidate, validateCopy, validateRaster } from './ai-content.js';

const TEXT_MODELS = new Set(['@cf/meta/llama-3.1-8b-instruct', '@cf/google/gemma-3-12b-it']);
const IMAGE_MODELS = new Set(['@cf/black-forest-labs/flux-1-schnell']);

class AIProviderError extends Error { constructor(code, message, details = {}) { super(message); this.code = code; Object.assign(this, details); } }
function fail(code, message, details) { throw new AIProviderError(code, message, details); }
function required(value, name) { if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) fail('AI_NOT_CONFIGURED', `${name} não configurado.`); return value; }
function safeJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.response === 'string') value = value.response;
    else if (typeof value.result === 'string') value = value.result;
    else if (typeof value.text === 'string') value = value.text;
    else return value;
  }
  try { return JSON.parse(String(value).trim()); } catch { fail('COPY_INVALID', 'A IA não devolveu JSON válido.'); }
}

export function createAIProvider(config, dependencies = {}) {
  if (config.openclawAiEnabled) return createOpenClawAIProvider(config, dependencies);
  const { fetchImpl = globalThis.fetch } = dependencies;
  if (typeof fetchImpl !== 'function') fail('AI_NOT_CONFIGURED', 'Cliente HTTP indisponível.');
  if (!config.aiFreeTierConfirmed) fail('AI_NOT_CONFIGURED', 'AI_FREE_TIER_CONFIRMED precisa ser true.');
  if (!TEXT_MODELS.has(config.textModel) || !IMAGE_MODELS.has(config.imageModel)) fail('AI_NOT_CONFIGURED', 'Modelo de IA fora da lista gratuita permitida.');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${required(config.cfAccountId, 'CF_ACCOUNT_ID')}/ai/run`;
  const headers = { Authorization: `Bearer ${required(config.cfApiToken, 'CF_API_TOKEN')}`, 'Content-Type': 'application/json' };
  async function call(model, input, timeoutMs = 120_000) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify({ model, input }), signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (response.status === 429 || response.status === 402) fail('AI_QUOTA', 'A franquia gratuita da IA foi atingida.', { httpStatus: response.status });
      if (!response.ok) fail('AI_UNAVAILABLE', 'O provedor de IA rejeitou a solicitação.', { httpStatus: response.status });
      if (!data?.success || data.result === undefined) fail('AI_INVALID_RESPONSE', 'Resposta inesperada do provedor de IA.');
      return data.result;
    } catch (error) { if (error instanceof AIProviderError) throw error; fail('AI_UNAVAILABLE', 'Não foi possível chamar o provedor de IA.'); }
    finally { clearTimeout(timer); }
  }
  return {
    async generateCopy(candidate) {
      const evidence = validateCandidate(candidate, fail);
      const result = safeJson(await call(config.textModel, { prompt: copyPrompt(evidence, randomUUID()), max_tokens: 1600 }));
      return validateCopy(result, evidence, fail);
    },
    async generateImage({ prompt }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) fail('AI_INVALID_INPUT', 'Prompt da imagem vazio ou acima do limite.');
      const result = await call(config.imageModel, { prompt: `${prompt}. Photorealistic documentary photography, no text, no logos, no watermark, one dominant subject, natural light.`, steps: 4 });
      const encoded = result?.image ?? result;
      const buffer = await validateRaster(decodeImageBase64(encoded, fail), fail);
      return { buffer, provider: 'cloudflare-workers-ai', model: config.imageModel, prompt, generatedAt: new Date().toISOString(), id: randomUUID() };
    },
  };
}
