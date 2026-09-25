import { resolve } from 'node:path';

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

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = resolve(cwd, env.VVC_DATA_DIR || './data');
  const outputDir = resolve(cwd, env.VVC_OUTPUT_DIR || './output');
  return {
    nodeEnv: env.NODE_ENV || 'development',
    dataDir,
    outputDir,
    timezone: env.VVC_TIMEZONE || 'America/Sao_Paulo',
    generationTime: env.VVC_GENERATION_TIME || '08:00',
    dailySlots: number(env.VVC_DAILY_SLOTS, 8, 1, 8),
    approvalRequired: bool(env.VVC_APPROVAL_REQUIRED, true),
    metaAppId: env.META_APP_ID || '',
    metaAppSecret: env.META_APP_SECRET || '',
    metaApiVersion: env.META_API_VERSION || 'v26.0',
    metaConfigId: env.META_CONFIG_ID || '',
    metaRedirectUri: env.META_REDIRECT_URI || '',
    metaPageId: env.META_PAGE_ID || '',
    metaPageToken: env.META_PAGE_TOKEN || '',
    metaPublishEnabled: bool(env.META_PUBLISH_ENABLED, false),
    cfAccountId: env.CF_ACCOUNT_ID || '',
    cfApiToken: env.CF_API_TOKEN || '',
    aiFreeTierConfirmed: bool(env.AI_FREE_TIER_CONFIRMED, false),
    // An already enabled OpenClaw deployment is the natural default for the
    // subscription-backed AI path; OPENCLAW_AI_ENABLED can still opt out.
    openclawAiEnabled: bool(env.OPENCLAW_AI_ENABLED, bool(env.OPENCLAW_ENABLED, false)),
    openclawAiModel: env.OPENCLAW_AI_MODEL || 'openai/gpt-5.6-sol',
    openclawAiAgent: env.OPENCLAW_AI_AGENT || 'main',
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
