import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile as defaultExecFile } from 'node:child_process';
import { promisify } from 'node:util';

class OpenClawAIError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; Object.assign(this, details); }
}

function fail(code, message, details) { throw new OpenClawAIError(code, message, details); }

function parseJson(value) {
  const text = String(value || '').trim();
  try { return JSON.parse(text); } catch { /* OpenClaw may prefix diagnostics. */ }
  const decoder = new JSONDecoder();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;
    try { const result = decoder.rawDecode(text.slice(index)); if (result.value && typeof result.value === 'object') return result.value; } catch { /* try next brace */ }
  }
  fail('AI_INVALID_RESPONSE', 'O OpenClaw devolveu uma resposta inválida.');
}

// JSON.parse has no rawDecode; keeping this tiny decoder separate makes the
// stdout parser testable while avoiding regex extraction from model text.
class JSONDecoder {
  rawDecode(text) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; continue; }
      if (char === '{') depth += 1;
      if (char === '}') { depth -= 1; if (depth === 0) return { value: JSON.parse(text.slice(0, index + 1)) }; }
    }
    throw new Error('incomplete json');
  }
}

function payload(result) {
  const item = result?.result?.payloads?.find((candidate) => candidate && typeof candidate === 'object') || {};
  const text = typeof item.text === 'string' ? item.text : '';
  const mediaUrl = item.mediaUrl || item.mediaUrls?.[0] || result?.result?.mediaUrl || null;
  return { text, mediaUrl };
}

function safeJson(value) {
  const text = String(value || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) fail('COPY_INVALID', 'A IA não devolveu JSON válido.');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { fail('COPY_INVALID', 'A IA não devolveu JSON válido.'); }
}

async function mediaBuffer(mediaUrl, fetchImpl) {
  if (typeof mediaUrl !== 'string' || !mediaUrl.trim()) fail('AI_INVALID_RESPONSE', 'A IA não devolveu a imagem.');
  if (mediaUrl.startsWith('data:image/')) {
    const comma = mediaUrl.indexOf(',');
    if (comma < 0) fail('AI_INVALID_RESPONSE', 'Data URL de imagem inválida.');
    return Buffer.from(mediaUrl.slice(comma + 1), 'base64');
  }
  if (/^https?:\/\//i.test(mediaUrl)) {
    const response = await fetchImpl(mediaUrl, { redirect: 'error' }).catch(() => null);
    if (!response?.ok) fail('AI_UNAVAILABLE', 'Não foi possível baixar a imagem gerada pelo OpenClaw.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024) fail('AI_INVALID_RESPONSE', 'A imagem gerada excede 32 MB.');
    return bytes;
  }
  if (mediaUrl.startsWith('file://')) {
    try { mediaUrl = new URL(mediaUrl).pathname; } catch { fail('AI_INVALID_RESPONSE', 'URL local de imagem inválida.'); }
  }
  if (!mediaUrl.startsWith('/')) fail('AI_INVALID_RESPONSE', 'O OpenClaw devolveu uma mídia fora de um caminho permitido.');
  try { return await readFile(mediaUrl); } catch { fail('AI_INVALID_RESPONSE', 'A imagem gerada pelo OpenClaw não está disponível.'); }
}

export function createOpenClawAIProvider(config, { execFileImpl = defaultExecFile, fetchImpl = globalThis.fetch } = {}) {
  if (!config.openclawAiEnabled) fail('AI_NOT_CONFIGURED', 'OPENCLAW_AI_ENABLED precisa ser true.');
  const execFile = promisify(execFileImpl);
  const bin = config.openclawBin || 'openclaw';
  const model = config.openclawAiModel || 'openai/gpt-5.6-sol';
  async function run(message, label) {
    try {
      const execution = await execFile(bin, [
        'agent', '--agent', config.openclawAiAgent || 'main',
        '--session-key', `agent:${config.openclawAiAgent || 'main'}:vvc-ai-${label}-${randomUUID()}`,
        '--message', message, '--model', model, '--json', '--timeout', '180',
      ], { timeout: 190_000, maxBuffer: 8 * 1024 * 1024, shell: false });
      const stdout = typeof execution === 'string' ? execution : execution?.stdout;
      const result = parseJson(stdout);
      if (result.status !== 'ok') fail('AI_UNAVAILABLE', 'O OpenClaw não concluiu a geração.');
      return payload(result);
    } catch (error) {
      if (error instanceof OpenClawAIError) throw error;
      fail('AI_UNAVAILABLE', 'Não foi possível chamar o OpenClaw para gerar o conteúdo.');
    }
  }
  return {
    async generateCopy(candidate) {
      if (!candidate?.topic || !Array.isArray(candidate.sources) || !candidate.sources.length) fail('COPY_INVALID', 'Candidato de pesquisa inválido.');
      const sourceIds = candidate.sources.map((source) => source.id).filter(Boolean);
      const prompt = `Você é o editor da página Você Vai Conhecer. Não use ferramentas. Responda SOMENTE com JSON válido, sem markdown. Fato pesquisado: ${candidate.topic}. Resumo: ${candidate.summary || ''}. Evidências: ${JSON.stringify(candidate.sources)}. Gere headline em pt-BR com no máximo 18 palavras; highlights com até 4 termos; caption informativa de até 900 caracteres; imagePrompt em inglês para fotografia documental realista sem texto. Inclua sourceIds usados e claims com sourceIds. Não invente dados. A legenda deve dizer que a imagem é ilustrativa gerada por IA.`;
      const result = safeJson((await run(prompt, 'copy')).text);
      if (typeof result.headline !== 'string' || !result.headline.trim() || typeof result.caption !== 'string' || !result.caption.trim() || typeof result.imagePrompt !== 'string' || !Array.isArray(result.sourceIds) || !result.sourceIds.every((id) => sourceIds.includes(id))) fail('COPY_INVALID', 'A cópia da IA não está fundamentada nas fontes.');
      const claims = Array.isArray(result.claims) ? result.claims : [];
      if (claims.some((claim) => !claim || typeof claim.text !== 'string' || !Array.isArray(claim.sourceIds) || !claim.sourceIds.every((id) => sourceIds.includes(id)))) fail('COPY_INVALID', 'As afirmações não têm fontes válidas.');
      return { headline: result.headline.trim(), highlights: Array.isArray(result.highlights) ? result.highlights.slice(0, 4) : [], caption: result.caption.includes('gerada por IA') ? result.caption : `${result.caption.trim()}\n\nImagem ilustrativa gerada por IA.`, imagePrompt: result.imagePrompt.trim(), sourceIds: result.sourceIds, claims };
    },
    async generateImage({ prompt }) {
      if (typeof prompt !== 'string' || !prompt.trim()) fail('AI_INVALID_INPUT', 'Prompt da imagem vazio.');
      const result = await run(`Use a ferramenta image_generate para criar uma única imagem. Prompt: ${prompt}. Fotografia documental realista, sem texto, logo ou marca-d'água, um assunto dominante, luz natural. Depois de gerar, responda somente DONE.`, 'image');
      const buffer = await mediaBuffer(result.mediaUrl, fetchImpl);
      if (buffer.length < 100) fail('AI_INVALID_RESPONSE', 'A imagem gerada está vazia.');
      return { buffer, provider: 'openclaw-codex', model, prompt, generatedAt: new Date().toISOString(), id: randomUUID() };
    },
  };
}

export { OpenClawAIError };
