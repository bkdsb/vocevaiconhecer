/** Read-only health monitor. Never generates text or changes model selection. */
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const split = (value) => String(value || '').split(/[,;\n]/u).map((item) => item.trim()).filter(Boolean);

export function configuredChain(env = process.env) {
  const codex = env.VVC_CODEX_MODEL || env.OPENCLAW_AI_MODEL || 'openai/gpt-6-astra';
  const models = split(env.VVC_FREE_TEXT_MODELS || [
    'google-genai/gemini-2.5-flash', 'google-genai/gemini-2.5-flash-lite',
    'groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b', 'openrouter/openrouter/free',
  ].join(','));
  return [
    { provider: 'openai', model: codex, routable: true },
    { provider: 'commander', model: 'chatgpt-web', routable: false },
    ...models.map((model) => ({
      provider: model.split('/')[0], model,
      // Free-tier keys do not imply that every OpenRouter model is free.
      routable: !model.startsWith('openrouter/') || model === 'openrouter/openrouter/free' || model.endsWith(':free'),
    })),
  ];
}

/** OAuth validity and quota availability differ; cooldown takes precedence. */
export function modelAvailability(payload, entry, now = Date.now()) {
  if (!entry.routable) return { status: 'unavailable', reason: entry.provider === 'commander' ? 'no-text-adapter' : 'nonfree-model' };
  const auth = payload?.auth;
  if (!auth || payload.ok === false || payload.error) return { status: 'unknown', reason: 'model-status-unavailable' };
  const provider = entry.provider;
  const modelId = entry.model.slice(provider.length + 1);
  const issues = (auth.modelRouteIssues || []).filter((issue) => issue.provider === provider && (!issue.model || issue.model === modelId));
  if (issues.length) return { status: 'unavailable', reason: 'auth-route-unavailable' };
  const oauthProvider = (auth.oauth?.providers || []).find((item) => item.provider === provider);
  const profiles = oauthProvider?.effectiveProfiles || oauthProvider?.profiles || (auth.oauth?.profiles || []).filter((item) => item.provider === provider);
  const unavailable = [...(auth.unusableProfiles || []), ...(auth.unavailableProfiles || [])].filter((item) => item.provider === provider && (!item.cooldownModel || item.cooldownModel === modelId));
  const isBlocked = (profile) => unavailable.some((item) => item.profileId === profile.profileId && (!item.until || Number(item.until) > now));
  const usable = profiles.filter((profile) => ['ok', 'static'].includes(profile.status) && !isBlocked(profile));
  if (profiles.length && !usable.length) {
    const cooldown = unavailable.filter((item) => item.kind === 'cooldown' && (!item.until || Number(item.until) > now));
    const retryAt = cooldown.map((item) => Number(item.until)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    return { status: 'unavailable', reason: cooldown.length ? 'cooldown' : 'auth-unavailable', ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}) };
  }
  if (usable.length) return { status: 'available', reason: 'configured-auth' };
  if ((auth.missingProvidersInUse || []).includes(provider)) return { status: 'unavailable', reason: 'missing-auth' };
  return { status: 'unknown', reason: 'auth-readiness-unknown' };
}

function runJson(command, args, execFileImpl = execFile) {
  return new Promise((resolveResult) => {
    execFileImpl(command, args, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolveResult(null);
      try { resolveResult(JSON.parse(stdout)); } catch { resolveResult(null); }
    });
  });
}

export async function collectHealth({ env = process.env, execFileImpl = execFile, now = new Date(), taskStatusImpl } = {}) {
  const binary = env.OPENCLAW_BIN || '/Users/belegante/.npm-global/bin/openclaw';
  const [gateway, models] = await Promise.all([
    runJson(binary, ['gateway', 'health', '--json'], execFileImpl),
    runJson(binary, ['models', 'status', '--json'], execFileImpl),
  ]);
  const chain = configuredChain(env).map((entry) => ({ ...entry, ...modelAvailability(models, entry, now.getTime()) }));
  let taskSummary = { status: 'unknown' };
  if (taskStatusImpl) {
    try {
      const tasks = await taskStatusImpl();
      const rows = Array.isArray(tasks) ? tasks : null;
      taskSummary = { status: 'checked',
        running: rows ? rows.filter((task) => ['running', 'queued'].includes(task.status)).length : Number(tasks.running) || 0,
        interrupted: rows ? rows.filter((task) => task.status === 'interrupted').length : Number(tasks.interrupted) || 0,
        failed: rows ? rows.filter((task) => task.status === 'failed').length : Number(tasks.failed) || 0,
        notificationsPending: rows ? rows.filter((task) => task.notices?.some((notice) => ['pending', 'attempted', 'unconfirmed'].includes(notice.delivery))).length : Number(tasks.notificationsPending) || 0,
      };
    } catch { taskSummary = { status: 'unavailable' }; }
  }
  // Allowlist output: no credential labels, chat contents, paths or raw errors.
  return {
    lastCheck: now.toISOString(), mode: 'metadata-only',
    gateway: { status: gateway?.ok === true ? 'available' : gateway ? 'unavailable' : 'unknown' },
    selectedModel: typeof models?.resolvedDefault === 'string' ? models.resolvedDefault : null,
    preferredAvailableModel: chain.find((entry) => entry.routable && entry.status === 'available')?.model || null,
    chain, tasks: taskSummary,
  };
}

export function saveHealth(state, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function main(args = process.argv.slice(2)) {
  try { process.loadEnvFile(join(PROJECT_ROOT, '.env')); } catch { /* explicit environment still works */ }
  const stateFile = join(process.env.VVC_DATA_DIR || join(PROJECT_ROOT, 'data'), 'heartbeat-state.json');
  if (args.includes('--status')) {
    let old; try { old = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { old = {}; }
    console.log(JSON.stringify({ lastCheck: old.lastCheck || null, mode: 'metadata-only', gateway: old.gateway?.status || 'unknown' }, null, 2));
    return;
  }
  if (!args.includes('--check') && !args.includes('--recover')) {
    console.log('Uso: node smart-heartbeat.js [--check|--recover|--status]');
    return;
  }
  // --recover is retained for existing jobs; it never mutates model configuration.
  const state = await collectHealth({ taskStatusImpl: async () => {
    const tasks = await runJson(process.execPath, [join(PROJECT_ROOT, 'src/cli.js'), 'task-check']);
    if (!tasks) throw new Error('task-status-unavailable');
    return tasks;
  } });
  saveHealth(state, stateFile);
  console.log(JSON.stringify(state, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('[heartbeat] Falha na leitura de saúde; nenhum modelo foi alterado.'); process.exitCode = 1; });
}
