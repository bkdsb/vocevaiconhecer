import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as defaultExecFile } from 'node:child_process';
import { MAX_IMAGE_BYTES, copyPrompt, decodeImageBase64, validateCandidate, validateCopy, validateRaster } from './ai-content.js';

class OpenClawAIError extends Error {
  constructor(code, message) { super(message); this.name = 'OpenClawAIError'; this.code = code; }
}
function fail(code, message) { throw new OpenClawAIError(code, message); }
const QUOTA = /cooldown|quota|rate[_ -]?limit|usage[_ -]?limit|too many requests|\b429\b|limit.{0,30}(?:reached|exceeded)/iu;
function unavailable(detail = '') {
  if (QUOTA.test(String(detail))) fail('AI_QUOTA', 'A assinatura Codex atingiu um limite temporário ou está em cooldown. Tente novamente após a liberação da franquia.');
  fail('AI_UNAVAILABLE', 'O OpenClaw não concluiu a geração com a conta Codex configurada.');
}

// Scan balanced JSON values so diagnostic braces, nested objects and quoted
// braces cannot make us select a log record instead of the CLI result envelope.
function jsonObjects(stdout) {
  const values = [];
  for (let start = 0; start < stdout.length; start += 1) {
    if (stdout[start] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let end = start; end < stdout.length; end += 1) {
      const ch = stdout[end];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') { quoted = true; continue; }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth !== 0) continue;
        try { values.push(JSON.parse(stdout.slice(start, end + 1))); start = end; } catch { /* diagnostic, not JSON */ }
        break;
      }
    }
  }
  return values;
}

function parseEnvelope(stdout) {
  if (typeof stdout !== 'string') fail('AI_INVALID_RESPONSE', 'O OpenClaw devolveu uma resposta inválida.');
  const envelopes = jsonObjects(stdout).filter((value) => value && typeof value.status === 'string' && ('result' in value || 'error' in value || 'runId' in value));
  if (envelopes.length !== 1) fail('AI_INVALID_RESPONSE', 'O OpenClaw devolveu uma resposta ausente ou ambígua.');
  return envelopes[0];
}

function validateEnvelope(envelope, model) {
  if (envelope.status !== 'ok') unavailable(JSON.stringify(envelope.error || envelope.result?.error || envelope.summary || ''));
  const result = envelope.result;
  const meta = result?.meta;
  const agent = meta?.agentMeta;
  const matches = (provider, reportedModel) => provider === 'openai' && (reportedModel === model || reportedModel === model.slice('openai/'.length));
  if (!matches(agent?.provider, agent?.model)) fail('AI_MODEL_MISMATCH', 'A geração não confirmou o provedor e o modelo Codex configurados.');
  const trace = meta?.executionTrace;
  if ((Array.isArray(agent.fallbackAttempts) && agent.fallbackAttempts.length) || trace?.fallbackUsed === true
    || (trace && (trace.winnerProvider || trace.winnerModel) && !matches(trace.winnerProvider, trace.winnerModel))
    || (Array.isArray(trace?.attempts) && trace.attempts.some((attempt) => !matches(attempt.provider, attempt.model)))) fail('AI_MODEL_MISMATCH', 'O OpenClaw tentou usar um provedor ou modelo alternativo.');
  const payloads = result?.payloads;
  const reasons = [meta?.stopReason, meta?.completion?.stopReason, meta?.completion?.finishReason, result?.stopReason].filter((reason) => reason !== undefined && reason !== null);
  if (meta?.aborted === true || result?.aborted === true || !reasons.length || reasons.some((reason) => !['stop', 'end_turn', 'completed', 'stop_sequence'].includes(reason))
    || result?.error || meta?.error || meta?.refusal || result?.refusal) unavailable(JSON.stringify({ error: result?.error || meta?.error, reasons }));
  if (!Array.isArray(payloads) || !payloads.length || payloads.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) fail('AI_INVALID_RESPONSE', 'O OpenClaw não devolveu conteúdo utilizável.');
  if (payloads.some((item) => item.isError || item.error || item.refusal || item.type === 'refusal' || item.aborted)) unavailable(JSON.stringify(payloads));
  const texts = payloads.map((item) => typeof item.text === 'string' ? item.text : '').filter((text) => text.trim());
  const media = [...new Set(payloads.flatMap((item) => [item.mediaUrl, ...(Array.isArray(item.mediaUrls) ? item.mediaUrls : [])]).filter((item) => item !== undefined && item !== null && item !== ''))];
  if (!texts.length && !media.length) fail('AI_INVALID_RESPONSE', 'O OpenClaw devolveu uma geração vazia.');
  return { text: texts.join('\n'), media };
}

async function readMedia(mediaUrl, allowedRoot) {
  if (typeof mediaUrl !== 'string' || !mediaUrl || mediaUrl !== mediaUrl.trim()) fail('AI_INVALID_RESPONSE', 'A IA não devolveu uma imagem válida.');
  if (mediaUrl.startsWith('data:')) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u.exec(mediaUrl);
    if (!match) fail('AI_INVALID_RESPONSE', 'Data URL de imagem inválida.');
    return decodeImageBase64(match[2], fail);
  }
  if (/^https?:/iu.test(mediaUrl)) fail('AI_INVALID_RESPONSE', 'URLs remotas de imagens não são permitidas; use mídia local do OpenClaw.');
  if (mediaUrl.startsWith('file:')) {
    try { mediaUrl = fileURLToPath(mediaUrl); } catch { fail('AI_INVALID_RESPONSE', 'URL local de imagem inválida.'); }
  }
  if (!isAbsolute(mediaUrl) || typeof allowedRoot !== 'string' || !isAbsolute(allowedRoot)) fail('AI_NOT_CONFIGURED', 'OPENCLAW_MEDIA_DIR deve definir a pasta permitida de imagens.');
  let handle;
  try {
    const [root, file] = await Promise.all([realpath(allowedRoot), realpath(mediaUrl)]);
    const inside = relative(root, file);
    if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) fail('AI_INVALID_RESPONSE', 'A imagem está fora da pasta de mídia permitida.');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) fail('AI_INVALID_RESPONSE', 'A imagem gerada está vazia ou excede 32 MB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) fail('AI_INVALID_RESPONSE', 'O arquivo de imagem mudou durante a leitura.');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof OpenClawAIError) throw error;
    fail('AI_INVALID_RESPONSE', 'A imagem gerada pelo OpenClaw não está disponível na pasta permitida.');
  } finally { await handle?.close(); }
}

function execute(config, args, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(config.openclawBin || 'openclaw', args, { timeout: 190_000, maxBuffer: 48 * 1024 * 1024, shell: false, env: { ...process.env, OPENAI_API_KEY: '', OPENAI_TOKEN: '' } }, (error, output, stderr) => {
      if (error) { try { unavailable(`${error.code || ''} ${output || ''} ${stderr || ''}`); } catch (safeError) { reject(safeError); } }
      else resolve(typeof output === 'string' ? output : output?.stdout);
    });
  });
}

export function createOpenClawTextRunner(config, { execFileImpl = defaultExecFile } = {}) {
  if (!config.openclawAiEnabled) fail('AI_NOT_CONFIGURED', 'OPENCLAW_AI_ENABLED precisa ser true.');
  const model = config.openclawAiModel || 'openai/gpt-5.6-sol';
  if (!/^openai\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model)) fail('AI_NOT_CONFIGURED', 'OPENCLAW_AI_MODEL deve selecionar um modelo da conta OpenAI.');
  return async function runText(message, { agent = config.openclawAiAgent || 'vvc-editor', label = 'text' } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(agent)) fail('AI_NOT_CONFIGURED', 'O agente OpenClaw configurado é inválido.');
    if (typeof message !== 'string' || !message.trim() || message.length > 150_000) fail('AI_INVALID_INPUT', 'A solicitação de texto é inválida ou acima do limite.');
    try {
      const stdout = await execute(config, ['agent', '--agent', agent, '--session-key', `agent:${agent}:vvc-ai-${label}-${randomUUID()}`, '--message', message, '--model', model, '--json', '--timeout', '180'], execFileImpl);
      return validateEnvelope(parseEnvelope(stdout), model);
    } catch (error) {
      if (error instanceof OpenClawAIError) throw error;
      unavailable();
    }
  };
}

export function createOpenClawAIProvider(config, dependencies = {}) {
  const runText = createOpenClawTextRunner(config, dependencies);
  const execFileImpl = dependencies.execFileImpl || defaultExecFile;
  return {
    async generateCopy(candidate) {
      const evidence = validateCandidate(candidate, fail);
      const response = await runText(copyPrompt(evidence, randomUUID()), { label: 'copy' });
      if (response.media.length) fail('COPY_INVALID', 'O editor devolveu mídia inesperada.');
      let result;
      try { result = JSON.parse(response.text.trim()); } catch { fail('COPY_INVALID', 'A IA não devolveu somente JSON válido.'); }
      return validateCopy(result, evidence, fail);
    },
    async generateImage({ prompt }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) fail('AI_INVALID_INPUT', 'Prompt da imagem vazio ou acima do limite.');
      const model = config.openclawImageModel || 'openai/gpt-image-2';
      if (!/^openai\/gpt-image-[A-Za-z0-9._-]+$/u.test(model) || !isAbsolute(config.openclawMediaDir || '')) fail('AI_NOT_CONFIGURED', 'Configure o modelo OpenAI de imagem e a pasta absoluta de mídia.');
      // Preflight before spending any image quota: native infer must have no
      // fallback and no explicit OpenAI API provider override (a billed route).
      const readConfig = async (key) => {
        const objects = jsonObjects(await execute(config, ['config', 'get', key, '--json'], execFileImpl));
        if (objects.length !== 1) fail('AI_NOT_CONFIGURED', 'Não foi possível confirmar a configuração segura de imagens do OpenClaw.');
        return objects[0];
      };
      const imageConfig = await readConfig('agents.defaults.imageGenerationModel');
      if (imageConfig.primary !== model || !Array.isArray(imageConfig.fallbacks) || imageConfig.fallbacks.length) fail('AI_NOT_CONFIGURED', 'O modelo de imagem deve ter fallbacks explicitamente vazios.');
      const modelsConfig = await readConfig('models');
      if (Object.keys(modelsConfig.providers?.openai || {}).length) fail('AI_NOT_CONFIGURED', 'Remova o override de API OpenAI para usar exclusivamente a assinatura Codex.');
      const auth = jsonObjects(await execute(config, ['models', 'auth', 'list', '--provider', 'openai', '--json'], execFileImpl));
      if (auth.length !== 1 || !Array.isArray(auth[0].profiles) || !auth[0].profiles.length || auth[0].profiles.some((profile) => profile.provider !== 'openai' || profile.type !== 'oauth')) fail('AI_NOT_CONFIGURED', 'Configure somente perfis OAuth OpenAI para geração de imagens pela assinatura.');
      await mkdir(config.openclawMediaDir, { recursive: true });
      const id = randomUUID();
      const outputPath = join(config.openclawMediaDir, `${id}.png`);
      const stdout = await execute(config, ['infer', 'image', 'generate', '--model', model, '--prompt', prompt, '--count', '1', '--size', '1024x1536', '--output-format', 'png', '--output', outputPath, '--timeout-ms', '180000', '--json'], execFileImpl);
      const envelopes = jsonObjects(stdout).filter((item) => item.capability === 'image.generate');
      if (envelopes.length !== 1) fail('AI_INVALID_RESPONSE', 'O OpenClaw não confirmou a geração da imagem.');
      const result = envelopes[0];
      if (result.ok !== true) unavailable(JSON.stringify(result.error || ''));
      if (result.provider !== 'openai' || ![model, model.slice('openai/'.length)].includes(result.model) || !Array.isArray(result.attempts) || result.attempts.length) fail('AI_MODEL_MISMATCH', 'A imagem não confirmou o modelo configurado sem alternativas.');
      if (!Array.isArray(result.outputs) || result.outputs.length !== 1 || typeof result.outputs[0]?.path !== 'string' || resolve(result.outputs[0].path) !== outputPath) fail('AI_INVALID_RESPONSE', 'O OpenClaw deve devolver uma única imagem no arquivo solicitado.');
      const buffer = await validateRaster(await readMedia(result.outputs[0].path, config.openclawMediaDir), fail);
      return { buffer, provider: 'openclaw-codex', model, prompt, generatedAt: new Date().toISOString(), id };
    },
  };
}

export { OpenClawAIError };
