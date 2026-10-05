import { spawn as defaultSpawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createOpenClawProvider } from './providers/openclaw.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ACTIVE = new Set(['queued', 'running']);
function validId(id) { if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('ID de tarefa inválido.'); return id; }
function taskPath(config, id) { return resolve(config.dataDir, 'tasks', `${validId(id)}.json`); }
export function parseTaskArguments(command, args = []) {
  if (!['research', 'batch'].includes(command)) throw new Error('Use task research [--target-day YYYY-MM-DD] ou task batch --plan-id ID.');
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--discover-only' && command === 'research' && !options.discoverOnly) { options.discoverOnly = true; continue; }
    if (arg === '--target-day' && !options.targetDay && /^\d{4}-\d{2}-\d{2}$/.test(args[index + 1] || '')) {
      const value = args[++index]; const date = new Date(`${value}T12:00:00Z`);
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) { options.targetDay = value; continue; }
    }
    if (arg === '--plan-id' && command === 'batch' && !options.planId && /^[a-f0-9]{8}$/.test(args[index + 1] || '')) { options.planId = args[++index]; continue; }
    throw new Error('Argumentos inválidos. Use research [--target-day YYYY-MM-DD] [--discover-only] ou batch --plan-id ID.');
  }
  if (command === 'batch' && !options.planId) throw Object.assign(new Error('Aprove os temas antes de gerar imagens. Use batch --plan-id ID.'), { code: 'TOPIC_APPROVAL_REQUIRED' });
  return options;
}
function bounded(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : fallback; }
function limits(command, env = process.env) {
  const deadlineMs = bounded(env[`VVC_TASK_${command.toUpperCase()}_DEADLINE_MS`], command === 'research' ? 900_000 : 2_100_000, 60_000, 3_600_000);
  return { deadlineMs, stallMs: bounded(env.VVC_TASK_STALL_MS, command === 'research' ? 480_000 : 720_000, 60_000, deadlineMs), progressMs: bounded(env.VVC_TASK_PROGRESS_MS, 60_000, 30_000, 120_000) };
}
export function sanitizeTaskOutput(text) {
  return String(text).replace(/\b(?:AIza[\w-]+|AQ\.[\w-]+|gsk_[\w-]+|sk-[\w-]+|EAA[\w-]{20,})\b/g, '[credencial removida]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[credencial removida]').slice(-1_600);
}
const safeCode = (value) => typeof value === 'string' && value.length <= 80 && /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z]+(?:_[a-z0-9]+)+)$/.test(value) ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const FRIENDLY_WARNINGS = {
  ENGINE_WARNING: 'Algum mecanismo de busca apresentou instabilidade',
  RESEARCH_COVERAGE_INCOMPLETE: 'Nem todas as fontes de pesquisa retornaram resultados completos',
  RESEARCH_FAILED: 'Uma das frentes de pesquisa falhou',
  SCRAPLING_FAILED: 'As fontes públicas de inspiração estão temporariamente indisponíveis',
  SCRAPLING_SOURCE_WARNING: 'Aviso na extração de postagens públicas de referência',
  FACEBOOK_POSTS_UNAVAILABLE: 'Nenhum post das páginas de referência pôde ser recuperado',
  EDITORIAL_SELECTION_FAILED: 'Falha na seleção editorial dos temas',
  EDITORIAL_VERIFICATION_REQUIRED: 'Os temas ainda precisam de validação de fontes',
  CANDIDATES_TRUNCATED: 'O número de temas encontrados excedeu o limite e foi ajustado',
  INSUFFICIENT_CURIOSITIES: 'Menos curiosidades validadas do que o ideal',
  INSUFFICIENT_NEWS: 'Menos notícias validadas do que o ideal',
  TOPIC_PLAN_EMPTY: 'Nenhum tema novo atendeu aos critérios',
  TOPIC_PLAN_DELIVERY_UNCONFIRMED: 'Não foi possível confirmar o envio das pautas pelo WhatsApp',
  TOPIC_PLAN_PARTIALLY_EXPIRED: 'Algumas pautas aprovadas expiraram antes da geração'
};

export function summarizeTaskResult(command, output) {
  let result; try { result = JSON.parse(String(output).trim()); } catch { return { limited: true, text: 'O processo terminou, mas não forneceu um resumo válido. O resultado precisa ser conferido.' }; }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { limited: true, text: 'O processo terminou sem um resumo válido; o resultado precisa ser conferido.' };
  const warnings = [...new Set((Array.isArray(result.warnings) ? result.warnings : []).map((warning) => safeCode(warning?.code)).filter(Boolean))].slice(0, 6);
  const friendlyWarnings = warnings.map(code => FRIENDLY_WARNINGS[code] || code);
  const warningText = friendlyWarnings.length ? ` Avisos: ${friendlyWarnings.join(', ')}.` : '';
  if (command === 'research') {
    const retained = count(result.counts?.retained);
    const verified = count(result.counts?.verified) ?? (count(result.counts?.verified?.curiosity) !== null && count(result.counts?.verified?.news) !== null ? result.counts.verified.curiosity + result.counts.verified.news : null);
    const limited = retained === null || retained === 0 || verified === 0 || warnings.length > 0;
    const planId = /^[a-f0-9]{8}$/.test(result.planId || '') ? result.planId : null;
    const topicCount = count(result.topicCount);
    const text = `${retained === 0 ? '❌ Nenhuma pauta foi encontrada para seguir à geração.' : verified === 0 ? '❌ Nenhuma pauta foi liberada para seguir à geração.' : `🔍 Vasculhamos ${retained} links e filtramos ${verified} úteis.`}${planId ? `\n✅ Plano ${planId}: ${topicCount === null ? 'temas aguardando' : `${topicCount} temas aguardando`} sua aprovação; imagens ainda não foram geradas.` : ''}${friendlyWarnings.length ? `\n⚠️ *Avisos:* ${friendlyWarnings.join(', ')}.` : ''}`;
    return { limited, retained, verified, planId, topicCount, warningCodes: warnings, text };
  }
  const selected = count(result.selected); const skipped = safeCode(result.skipped); const blocked = safeCode(result.blocked);
  const remaining = { curiosity: count(result.remaining?.curiosity), news: count(result.remaining?.news) };
  const limited = Boolean(skipped || blocked || result.partial || selected === null || selected === 0 || remaining.curiosity > 0 || remaining.news > 0);
  let text = selected === null ? 'Quantidade de posts selecionados não informada.' : `${selected} posts selecionados.`;
  const friendlySkipped = {
    already_created_today: 'já existe um para o dia',
    publishing_disabled: 'publicação desativada nas configurações',
    meta_not_configured: 'integração com o Meta não configurada',
    generation_disabled: 'criação automática de imagens desligada',
    meta_sync_unavailable: 'sincronização de posts na Meta indisponível'
  };
  const friendlyBlocked = {
    insufficient_topics: 'falta de pautas suficientes',
    api_error: 'erro de comunicação com a API'
  };
  if (skipped) text += ` Execução dispensada: ${friendlySkipped[skipped] || skipped}.`;
  if (blocked) text += ` Lote bloqueado: ${friendlyBlocked[blocked] || blocked}.`;
  if (remaining.curiosity !== null || remaining.news !== null) text += ` Ainda faltam ${remaining.curiosity ?? '?'} curiosidades e ${remaining.news ?? '?'} notícias para preencher o lote.`;
  return { limited, selected, skipped, blocked, remaining, warningCodes: warnings, text: text + warningText };
}

async function boundedSend(send, message, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => send(message)), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Envio sem confirmação no prazo.'), { code: 'OPENCLAW_UNKNOWN' })), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
async function save(config, state) {
  const path = taskPath(config, state.id); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(temp, path);
}

// The detached supervisor survives the main agent turn ending. It owns only its
// own child process group; no system-wide process matching or killing is used.
export async function startTask({ config, command, args = [], spawnImpl = defaultSpawn, projectRoot = ROOT }) {
  const options = parseTaskArguments(command, args);
  const state = { id: randomUUID(), command, args, ...options, status: 'queued', createdAt: new Date().toISOString(), ...limits(command), notices: [] };
  await save(config, state);
  try {
    const supervisor = spawnImpl(process.execPath, [resolve(projectRoot, 'src/task-runner.js'), '--supervise', state.id], { cwd: projectRoot, detached: true, stdio: 'ignore', env: process.env });
    await new Promise((accept, reject) => { supervisor.once('spawn', accept); supervisor.once('error', reject); });
    supervisor.unref(); return { jobId: state.id, status: 'queued', supervisorPid: supervisor.pid, statusCommand: `node src/cli.js task-status ${state.id}` };
  } catch (error) { state.status = 'failed'; state.errorCode = 'TASK_SUPERVISOR_START'; state.finishedAt = new Date().toISOString(); await save(config, state); throw error; }
}

export async function monitorTask({ state, child, send, persist, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, killChild = () => child.kill('SIGKILL'), sendTimeoutMs = 35_000 }) {
  const started = now(); let lastOutput = started; let tail = ''; let stdout = ''; let terminal = false; let stopping = null; let chain = Promise.resolve(); let interval; let complete;
  const done = new Promise((accept) => { complete = accept; });
  const enqueue = (operation) => { chain = chain.then(operation, operation); chain.catch(() => {}); return chain; };
  const stamp = () => new Date(now()).toISOString();
  async function checkpoint() { try { await persist(state); } catch { state.persistenceError = 'TASK_STATE_WRITE'; } }
  async function notice(kind, text) {
    const record = { kind, attemptedAt: stamp(), delivery: 'attempted' }; state.notices.push(record); state.notices = state.notices.slice(-64); await checkpoint();
    try { const result = await boundedSend(send, { text }, sendTimeoutMs); record.delivery = result?.skipped ? 'skipped' : 'sent'; }
    catch (error) { record.delivery = 'unconfirmed'; record.errorCode = /^OPENCLAW_[A-Z_]+$/.test(error.code || '') ? error.code : 'MESSAGE_UNCONFIRMED'; }
    // A send timeout can mean delivered. Never retry this same notice blindly.
    await checkpoint();
  }
  async function finish(status, code = null) {
    if (terminal) return; terminal = true; if (interval) clearIntervalImpl(interval);
    if (status === 'failed') {
      for (const line of tail.split('\n').reverse()) {
        try { const error = JSON.parse(line); if (safeCode(error?.error)) { code = error.error; break; } } catch { /* diagnostic line */ }
      }
      if (['AI_QUOTA', 'AI_IMAGE_FREE_UNAVAILABLE'].includes(code)) status = 'awaiting_quota';
    }
    state.status = status; state.finishedAt = stamp(); state.errorCode = code; state.outputTail = sanitizeTaskOutput(tail);
    if (status === 'completed') state.resultSummary = summarizeTaskResult(state.command, stdout);
    await checkpoint();
    const label = state.command === 'research' ? 'A pesquisa' : 'A geração do lote';
    const text = status === 'completed' ? `${label} terminou${state.resultSummary.limited ? ' com resultado limitado' : ''}. ${state.resultSummary.text} Tarefa ${state.id.slice(0, 8)} concluída.`
      : status === 'stalled' ? `${label} foi interrompida após ficar sem novos sinais de atividade. Tarefa ${state.id.slice(0, 8)} parada; nenhuma nova tentativa foi iniciada.`
        : status === 'awaiting_quota' ? `${label} parou e está aguardando a liberação da franquia de IA${code === 'AI_IMAGE_FREE_UNAVAILABLE' ? ' para imagens na assinatura Codex; nenhuma alternativa com gratuidade comprovada está configurada' : ''}. Tarefa ${state.id.slice(0, 8)}: os temas aprovados foram preservados. Nenhuma rota paga foi iniciada.`
        : status === 'timed_out' ? `${label} foi interrompida porque atingiu o limite de tempo. Tarefa ${state.id.slice(0, 8)} parada; nenhuma nova tentativa foi iniciada.`
          : status === 'interrupted' ? `${label} foi interrompida pelo encerramento do processo. Tarefa ${state.id.slice(0, 8)} parada.`
            : `${label} terminou com erro (${code || 'TASK_FAILED'}). Tarefa ${state.id.slice(0, 8)} parada; o erro foi registrado para análise.`;
    try { await notice('final', text); } finally { complete(state); }
  }
  child.stdout?.on('data', (chunk) => { lastOutput = now(); tail = (tail + String(chunk)).slice(-8_000); stdout = (stdout + String(chunk)).slice(-200_000); });
  child.stderr?.on('data', (chunk) => { lastOutput = now(); tail = (tail + String(chunk)).slice(-8_000); });
  child.once('error', () => { enqueue(() => finish('failed', 'TASK_CHILD_START')); });
  child.once('close', (code, signal) => { enqueue(() => finish(stopping?.status || (code === 0 ? 'completed' : 'failed'), stopping?.code || (signal ? 'TASK_CHILD_SIGNAL' : `EXIT_${code ?? 'UNKNOWN'}`))); });
  state.status = 'running'; state.startedAt = stamp(); state.supervisorPid = process.pid; state.childPid = child.pid; state.lastHeartbeatAt = stamp();
  enqueue(async () => { await checkpoint(); await notice('started', `${state.command === 'research' ? 'Pesquisa' : 'Geração do lote'} iniciada. Tarefa ${state.id.slice(0, 8)}: vou avisar enquanto estiver executando e quando concluir ou parar.`); });
  interval = setIntervalImpl(() => {
    if (terminal || stopping) return;
    const elapsed = now() - started;
    if (elapsed >= state.deadlineMs || now() - lastOutput >= state.stallMs) {
      stopping = { status: elapsed >= state.deadlineMs ? 'timed_out' : 'stalled', code: elapsed >= state.deadlineMs ? 'TASK_DEADLINE' : 'TASK_NO_ACTIVITY' };
      clearIntervalImpl(interval);
      // Termination is outside the notification queue, so even a hanging send
      // cannot keep the research process alive beyond its deadline.
      try { killChild(); } catch { /* the owned process may already have ended */ }
      enqueue(() => finish(stopping.status, stopping.code)); return;
    }
    enqueue(async () => {
    if (terminal || stopping) return; state.lastHeartbeatAt = stamp(); state.lastOutputAt = new Date(lastOutput).toISOString();
    await notice('progress', `${state.command === 'research' ? 'A pesquisa' : 'A geração do lote'} ainda está executando (${Math.max(1, Math.floor(elapsed / 60_000))} min). Ainda não recebi o resultado final. Tarefa ${state.id.slice(0, 8)}.`);
    });
  }, state.progressMs);
  const interrupted = () => { if (terminal || stopping) return; stopping = { status: 'interrupted', code: 'TASK_SUPERVISOR_SIGNAL' }; try { killChild(); } catch {} enqueue(() => finish(stopping.status, stopping.code)); };
  return { done, interrupted, flush: () => chain };
}

export async function taskStatus({ config, id, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, messenger = createOpenClawProvider(config) }) {
  const names = id ? [`${validId(id)}.json`] : await readdir(resolve(config.dataDir, 'tasks')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const tasks = [];
  for (const name of names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const state = JSON.parse(await readFile(resolve(config.dataDir, 'tasks', name), 'utf8'));
    const age = Date.now() - Date.parse(state.lastHeartbeatAt || state.createdAt);
    if (ACTIVE.has(state.status) && age > 120_000 && (!state.supervisorPid || !isAlive(state.supervisorPid))) {
      state.status = 'interrupted'; state.errorCode = 'TASK_SUPERVISOR_LOST'; state.finishedAt = new Date().toISOString();
      const notice = { kind: 'final', attemptedAt: state.finishedAt, delivery: 'attempted' }; state.notices.push(notice); await save(config, state);
      try { const result = await messenger.send({ text: `A tarefa ${state.id.slice(0, 8)} (${state.command === 'research' ? 'pesquisa' : 'lote'}) foi interrompida: o supervisor não está mais executando. O resultado não foi confirmado. Nenhuma nova execução foi iniciada.` }); notice.delivery = result?.skipped ? 'skipped' : 'sent'; }
      catch { notice.delivery = 'unconfirmed'; } await save(config, state);
    }
    tasks.push({ ...state, outputTail: undefined });
  }
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function supervise(id) {
  process.chdir(ROOT); if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'));
  const config = loadConfig(); const state = JSON.parse(await readFile(taskPath(config, id), 'utf8'));
  if (!Array.isArray(state.args)) throw new Error('Estado de tarefa inválido.');
  parseTaskArguments(state.command, state.args);
  const child = defaultSpawn(process.execPath, [resolve(ROOT, 'src/cli.js'), state.command, ...state.args], { cwd: ROOT, env: { ...process.env, VVC_TASK_MANAGED: '1' }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const messenger = createOpenClawProvider(config);
  const monitor = await monitorTask({ state, child, send: (message) => messenger.send(message), persist: (value) => save(config, value), killChild: () => { if (!child.pid) return; if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } });
  process.once('SIGTERM', monitor.interrupted); process.once('SIGINT', monitor.interrupted);
  await monitor.done;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  supervise(process.argv[3]).catch(() => { process.exitCode = 1; });
}
