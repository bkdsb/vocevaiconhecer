import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const exec = promisify(execFile);

/**
 * Runs a command on the remote server via SSH and returns its stdout.
 * @param {object} options
 * @param {string} options.sshKey   — path to the private key
 * @param {string} options.sshHost  — user@host
 * @param {string} options.command  — remote command to execute
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<string>}
 */
async function sshExec({ sshKey, sshHost, command, timeoutMs = 30_000 }) {
  const args = [
    '-i', sshKey,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 2000)}`,
    sshHost,
    command,
  ];
  const { stdout } = await exec('ssh', args, { timeout: timeoutMs, maxBuffer: 4_000_000, shell: false });
  return stdout;
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Checks the health of the remote server and returns a structured report.
 * @param {object} config — must include sshKey, sshHost, remoteDir
 * @returns {Promise<object>}
 */
export async function checkServer(config) {
  const { sshKey, sshHost, remoteDir } = config;
  if (!sshKey || !sshHost || !remoteDir) {
    throw Object.assign(new Error('Configure VVC_SSH_KEY, VVC_SSH_HOST e VVC_REMOTE_DIR.'), { code: 'MONITOR_NOT_CONFIGURED' });
  }
  const key = resolve(sshKey.replace(/^~/, process.env.HOME || '/tmp'));
  const run = (command) => sshExec({ sshKey: key, sshHost, command, timeoutMs: 30_000 });
  const report = { checkedAt: new Date().toISOString(), server: sshHost, ok: true, issues: [] };

  // 1. OpenClaw Gateway
  try {
    const raw = await run('openclaw gateway status --json 2>/dev/null');
    const gateway = tryJson(raw);
    report.gateway = {
      running: gateway?.service?.runtime?.status === 'running',
      version: gateway?.gateway?.version || gateway?.cli?.version || 'unknown',
      pid: gateway?.service?.runtime?.pid || null,
      port: gateway?.gateway?.port || null,
    };
    if (!report.gateway.running) { report.ok = false; report.issues.push('Gateway OpenClaw não está rodando'); }
  } catch {
    report.gateway = { running: false, version: 'unknown', error: 'Não foi possível consultar o gateway' };
    report.ok = false; report.issues.push('Falha ao consultar gateway OpenClaw');
  }

  // 2. VVC Worker + 3. systemd service (combined to reduce SSH calls)
  try {
    const raw = await run('systemctl --user is-active vocevaiconhecer 2>/dev/null; echo "---"; systemctl --user show vocevaiconhecer --property=MainPID --property=ActiveState 2>/dev/null');
    const lines = raw.trim().split('\n');
    const serviceActive = lines[0]?.trim() === 'active';
    const mainPid = lines.find((l) => l.startsWith('MainPID='))?.split('=')[1]?.trim();
    report.service = { status: serviceActive ? 'active' : lines[0]?.trim() || 'unknown' };
    report.worker = { running: serviceActive, pid: mainPid || null };
    if (!serviceActive) { report.ok = false; report.issues.push('Worker VVC não está rodando'); }
  } catch {
    report.worker = { running: false, pid: null };
    report.service = { status: 'unknown' };
    report.ok = false; report.issues.push('Falha ao verificar worker VVC');
  }

  // 4. Database
  try {
    const raw = await run(`test -f ${remoteDir}/data/vvc.sqlite && echo 'FOUND' || echo '__NONE__'`);
    const exists = raw.includes('FOUND');
    report.database = { exists };
    if (!exists) { report.issues.push('Banco de dados SQLite não encontrado'); }
  } catch {
    report.database = { exists: false, error: 'Falha ao verificar banco' };
  }

  // 5. Latest batch (via VVC CLI)
  try {
    const raw = await run(`cd ${remoteDir} && node --env-file-if-exists=.env src/cli.js status 2>/dev/null`);
    report.latestBatch = tryJson(raw) || { status: 'parse_failed' };
  } catch {
    report.latestBatch = { status: 'unavailable' };
  }

  // 6. Codex tokens
  try {
    const raw = await run('openclaw status --json 2>/dev/null');
    const status = tryJson(raw);
    const sessions = status?.sessions?.recent || [];
    const vvcSessions = sessions.filter((s) => ['vvc-editor', 'vvc-research'].includes(s.agentId));
    report.codex = vvcSessions.map((s) => ({
      agent: s.agentId,
      model: s.model,
      runtime: s.runtime,
      percentUsed: s.percentUsed,
      remainingTokens: s.remainingTokens,
      totalTokens: s.totalTokens,
    }));
  } catch {
    report.codex = [];
  }

  // 7. WhatsApp
  try {
    const raw = await run('openclaw channels status --json 2>/dev/null || echo \'{"channels":{}}\'');
    const data = tryJson(raw);
    // channels is an object keyed by channel name, e.g. { whatsapp: { connected: true, ... } }
    const wa = data?.channels?.whatsapp || null;
    report.whatsapp = {
      connected: wa?.connected === true || wa?.statusState === 'linked',
      channel: wa,
    };
  } catch {
    report.whatsapp = { connected: false, error: 'Falha ao verificar WhatsApp' };
    report.issues.push('WhatsApp não está acessível');
  }

  // 8. VVC Plugin
  try {
    const raw = await run('openclaw plugins inspect vvc-auto-post --json 2>/dev/null');
    const plugin = tryJson(raw);
    report.plugin = {
      loaded: plugin?.plugin?.status === 'loaded',
      enabled: plugin?.plugin?.enabled === true,
      version: plugin?.plugin?.version || 'unknown',
    };
  } catch {
    report.plugin = { loaded: false, enabled: false };
  }

  // 9. System resources
  try {
    const disk = await run("df -h / | tail -1 | awk '{print $2,$3,$4,$5}'");
    const uptime = await run('uptime -s 2>/dev/null || uptime');
    const mem = await run("free -h 2>/dev/null | awk '/^Mem:/{print $2,$3,$4}' || echo 'n/a'");
    const parts = disk.trim().split(/\s+/);
    report.system = {
      disk: { total: parts[0], used: parts[1], available: parts[2], usePercent: parts[3] },
      uptime: uptime.trim(),
      memory: mem.trim(),
    };
  } catch {
    report.system = { error: 'Falha ao coletar métricas do sistema' };
  }

  return report;
}

/**
 * Deploys the local codebase to the remote server via rsync and restarts the worker.
 * @param {object} config — must include sshKey, sshHost, remoteDir, localDir
 * @returns {Promise<object>}
 */
export async function deployToServer(config) {
  const { sshKey, sshHost, remoteDir, localDir } = config;
  if (!sshKey || !sshHost || !remoteDir || !localDir) {
    throw Object.assign(new Error('Configure VVC_SSH_KEY, VVC_SSH_HOST, VVC_REMOTE_DIR.'), { code: 'DEPLOY_NOT_CONFIGURED' });
  }
  const key = resolve(sshKey.replace(/^~/, process.env.HOME || '/tmp'));
  const sshOpts = `ssh -i ${key} -o StrictHostKeyChecking=no -o BatchMode=yes`;
  const excludes = ['node_modules', '.env', 'data', 'output', '.git', '.DS_Store', '*.sqlite3', '.bridge-token', '.runtime'];
  const excludeArgs = excludes.flatMap((e) => ['--exclude', e]);
  const rsyncArgs = ['-avz', '--delete', '-e', sshOpts, ...excludeArgs, `${localDir}/`, `${sshHost}:${remoteDir}/`];
  const result = { syncedAt: new Date().toISOString(), steps: [] };

  // 1. Rsync
  try {
    const { stdout } = await exec('rsync', rsyncArgs, { timeout: 120_000, maxBuffer: 2_000_000 });
    result.steps.push({ step: 'rsync', ok: true, files: stdout.trim().split('\n').length });
  } catch (error) {
    result.steps.push({ step: 'rsync', ok: false, error: error.message });
    return result;
  }

  const run = (command) => sshExec({ sshKey: key, sshHost, command, timeoutMs: 60_000 });

  // 2. npm install (production)
  try {
    const raw = await run(`cd ${remoteDir} && npm install --omit=dev 2>&1 | tail -5`);
    result.steps.push({ step: 'npm_install', ok: true, output: raw.trim() });
  } catch (error) {
    result.steps.push({ step: 'npm_install', ok: false, error: error.message });
  }

  // 3. Restart worker
  try {
    const raw = await run('systemctl --user restart vocevaiconhecer 2>&1 && systemctl --user is-active vocevaiconhecer 2>&1');
    result.steps.push({ step: 'restart', ok: raw.trim() === 'active', status: raw.trim() });
  } catch (error) {
    result.steps.push({ step: 'restart', ok: false, error: error.message });
  }

  return result;
}
