import { randomUUID } from 'node:crypto';
import { createOpenClawAIProvider } from './openclaw-ai.js';

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
  const match = String(value).match(/\{[\s\S]*\}/);
  if (!match) fail('COPY_INVALID', 'A IA não devolveu JSON válido.');
  try { return JSON.parse(match[0]); } catch { fail('COPY_INVALID', 'A IA não devolveu JSON válido.'); }
}

export function createAIProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  if (config.openclawAiEnabled) return createOpenClawAIProvider(config, { fetchImpl });
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
      if (!candidate?.topic || !Array.isArray(candidate.sources)) fail('COPY_INVALID', 'Candidato de pesquisa inválido.');
      const sourceIds = candidate.sources.map((source) => source.id).filter(Boolean);
      const prompt = `Você é editor da página Você Vai Conhecer. Responda SOMENTE JSON válido. Fato: ${candidate.topic}. Evidências: ${JSON.stringify(candidate.sources)}. Gere headline em pt-BR, caixa alta implícita, máximo 18 palavras; highlights com até 4 termos; caption informativa em até 900 caracteres, sem afirmar mais do que as fontes; imagePrompt em inglês para fotografia documental realista sem texto. Inclua exatamente sourceIds usados e claims com sourceIds. A imagem é ilustrativa gerada por IA e isso deve aparecer na legenda.`;
      const result = safeJson(await call(config.textModel, { prompt, max_tokens: 1200 }));
      if (typeof result.headline !== 'string' || !result.headline.trim() || typeof result.caption !== 'string' || !result.caption.trim() || typeof result.imagePrompt !== 'string' || !Array.isArray(result.sourceIds) || !result.sourceIds.every((id) => sourceIds.includes(id))) fail('COPY_INVALID', 'A cópia da IA não está fundamentada nas fontes.');
      const claims = Array.isArray(result.claims) ? result.claims : [];
      if (claims.some((claim) => !claim || typeof claim.text !== 'string' || !Array.isArray(claim.sourceIds) || !claim.sourceIds.every((id) => sourceIds.includes(id)))) fail('COPY_INVALID', 'As afirmações não têm fontes válidas.');
      const caption = result.caption.includes('gerada por IA') ? result.caption : `${result.caption.trim()}\n\nImagem ilustrativa gerada por IA.`;
      return { headline: result.headline.trim(), highlights: Array.isArray(result.highlights) ? result.highlights.slice(0, 4) : [], caption, imagePrompt: result.imagePrompt.trim(), sourceIds: result.sourceIds, claims };
    },
    async generateImage({ prompt }) {
      if (typeof prompt !== 'string' || !prompt.trim()) fail('AI_INVALID_INPUT', 'Prompt da imagem vazio.');
      const result = await call(config.imageModel, { prompt: `${prompt}. Photorealistic documentary photography, no text, no logos, no watermark, one dominant subject, natural light.`, steps: 4 });
      const encoded = result?.image ?? result;
      if (typeof encoded !== 'string' || !encoded) fail('AI_INVALID_RESPONSE', 'A IA não devolveu uma imagem.');
      let buffer; try { buffer = Buffer.from(encoded, 'base64'); } catch { fail('AI_INVALID_RESPONSE', 'Imagem da IA inválida.'); }
      if (buffer.length < 100) fail('AI_INVALID_RESPONSE', 'Imagem da IA vazia.');
      return { buffer, provider: 'cloudflare-workers-ai', model: config.imageModel, prompt, generatedAt: new Date().toISOString(), id: randomUUID() };
    },
  };
}
