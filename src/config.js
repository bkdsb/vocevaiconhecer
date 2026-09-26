import { resolve } from 'node:path';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const BOOLS = new Set(['true', '1', 'yes', 'on']);

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return BOOLS.has(String(value).toLowerCase());
}

function number(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function list(value) {
  return String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function credentialsError(code = 'META_CREDENTIALS_INVALID') {
  const message = code === 'META_CREDENTIALS_INCOMPLETE'
    ? 'Defina META_PAGE_ID e META_PAGE_TOKEN juntos ou deixe ambos vazios para usar o arquivo privado.'
    : 'O arquivo privado de credenciais Meta está ausente, inválido ou não pertence ao aplicativo configurado.';
  return Object.assign(new Error(message), { code });
}

function validId(value) { return typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value); }
function validToken(value) { return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\s\u0000-\u001f\u007f]/u.test(value); }

function metaCredentials(env, path) {
  const explicitId = env.META_PAGE_ID !== undefined && env.META_PAGE_ID !== '';
  const explicitToken = env.META_PAGE_TOKEN !== undefined && env.META_PAGE_TOKEN !== '';
  if (explicitId || explicitToken) {
    if (!explicitId || !explicitToken) throw credentialsError('META_CREDENTIALS_INCOMPLETE');
    if (!validId(env.META_PAGE_ID) || !validToken(env.META_PAGE_TOKEN)) throw credentialsError();
    return { metaPageId: env.META_PAGE_ID, metaPageToken: env.META_PAGE_TOKEN };
  }
  let file;
  try {
    // NONBLOCK lets fstat reject named pipes without waiting for their writer.
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    if (!info.isFile() || info.size <= 0 || info.size > 64 * 1024 || (info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw credentialsError();
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(file, bytes, length, bytes.length - length, length); if (count === 0) break; length += count; }
    if (length !== info.size) throw credentialsError();
    const record = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) || !validId(record.appId) || record.appId !== env.META_APP_ID || !validId(record.pageId) || !validToken(record.pageToken)
      || typeof record.pageName !== 'string' || !record.pageName.trim() || record.pageName.length > 1024 || /[\u0000-\u001f\u007f]/u.test(record.pageName)
      || typeof record.validatedAt !== 'string' || !Number.isFinite(Date.parse(record.validatedAt)) || new Date(record.validatedAt).toISOString() !== record.validatedAt) throw credentialsError();
    return { metaPageId: record.pageId, metaPageToken: record.pageToken };
  } catch (error) {
    if (error.code === 'ENOENT' && !env.META_CREDENTIALS_FILE) return { metaPageId: '', metaPageToken: '' };
    throw credentialsError();
  } finally { if (file !== undefined) closeSync(file); }
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = resolve(cwd, env.VVC_DATA_DIR || './data');
  const outputDir = resolve(cwd, env.VVC_OUTPUT_DIR || './output');
  const metaCredentialsFile = env.META_CREDENTIALS_FILE ? resolve(cwd, env.META_CREDENTIALS_FILE) : resolve(dataDir, 'meta/page.json');
  const pageCredentials = metaCredentials(env, metaCredentialsFile);
  return {
    nodeEnv: env.NODE_ENV || 'development',
    dataDir,
    outputDir,
    timezone: env.VVC_TIMEZONE || 'America/Sao_Paulo',
    generationTime: env.VVC_GENERATION_TIME || '08:00',
    generationEnabled: bool(env.VVC_GENERATION_ENABLED, false),
    dailySlots: number(env.VVC_DAILY_SLOTS, 8, 1, 8),
    approvalRequired: bool(env.VVC_APPROVAL_REQUIRED, true),
    metaAppId: env.META_APP_ID || '',
    metaAppSecret: env.META_APP_SECRET || '',
    metaApiVersion: env.META_API_VERSION || 'v26.0',
    metaConfigId: env.META_CONFIG_ID || '',
    metaRedirectUri: env.META_REDIRECT_URI || '',
    metaCredentialsFile,
    ...pageCredentials,
    metaPublishEnabled: bool(env.META_PUBLISH_ENABLED, false),
    cfAccountId: env.CF_ACCOUNT_ID || '',
    cfApiToken: env.CF_API_TOKEN || '',
    aiFreeTierConfirmed: bool(env.AI_FREE_TIER_CONFIRMED, false),
    openclawAiEnabled: bool(env.OPENCLAW_AI_ENABLED, false),
    openclawAiModel: env.OPENCLAW_AI_MODEL || 'openai/gpt-5.6-sol',
    openclawAiAgent: env.OPENCLAW_AI_AGENT || 'vvc-editor',
    openclawResearchAgent: env.OPENCLAW_RESEARCH_AGENT || 'vvc-research',
    openclawImageModel: env.OPENCLAW_IMAGE_MODEL || 'openai/gpt-image-2',
    openclawMediaDir: resolve(cwd, env.OPENCLAW_MEDIA_DIR || './output/ai'),
    textModel: env.AI_TEXT_MODEL || '@cf/meta/llama-3.1-8b-instruct',
    imageModel: env.AI_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell',
    openclawBin: env.OPENCLAW_BIN || 'openclaw',
    whatsappTarget: env.OPENCLAW_WHATSAPP_TARGET || '',
    whatsappAccount: env.OPENCLAW_WHATSAPP_ACCOUNT || 'default',
    openclawEnabled: bool(env.OPENCLAW_ENABLED, false),
    bridgeToken: env.VVC_BRIDGE_TOKEN || '',
    allowedSenders: list(env.VVC_ALLOWED_SENDERS),
    last30daysDir: resolve(cwd, env.LAST30DAYS_DIR || './data/last30days'),
    last30daysRepo: env.LAST30DAYS_REPO || 'https://github.com/mvanhorn/last30days-skill.git',
    last30daysSha: env.LAST30DAYS_SHA || '084662b501fb0dba95bd55eff0c258d35e0dc499',
    pythonBin: env.LAST30DAYS_PYTHON || 'python3.12',
    researchTimeoutMs: number(env.RESEARCH_TIMEOUT_MS, 300_000, 10_000, 900_000),
  };
}

export function publicConfig(config) {
  return {
    nodeEnv: config.nodeEnv,
    timezone: config.timezone,
    generationTime: config.generationTime,
    generationEnabled: config.generationEnabled,
    dailySlots: config.dailySlots,
    approvalRequired: config.approvalRequired,
    metaConfigured: Boolean(config.metaAppId && config.metaAppSecret && config.metaRedirectUri),
    metaPageConfigured: Boolean(config.metaPageId && config.metaPageToken),
    metaPublishEnabled: config.metaPublishEnabled,
    aiConfigured: Boolean(config.cfAccountId && config.cfApiToken),
    aiFreeTierConfirmed: config.aiFreeTierConfirmed,
    openclawAiConfigured: Boolean(config.openclawAiEnabled),
    openclawConfigured: Boolean(config.openclawEnabled && config.whatsappTarget),
    researchDir: config.last30daysDir,
  };
}
