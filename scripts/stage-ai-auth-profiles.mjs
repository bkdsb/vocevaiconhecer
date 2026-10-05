import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PATTERNS = {
  'google-genai': /(?:AQ\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,})/gu,
  groq: /gsk_[A-Za-z0-9_-]{20,}/gu,
  openrouter: /sk-or-v1-[a-f0-9]{32,}/gu,
};

// Only key counts and profile IDs may leave this parser. Never print source
// lines, credential values, CLI output, or secret-bearing error objects.
export function extractProviderKeys(source) {
  return Object.fromEntries(Object.entries(PATTERNS).map(([provider, pattern]) => [provider, [...new Set(String(source).match(pattern) || [])]]));
}
export function profileImportPlan(keys, agents) {
  if (!agents.length || agents.some((agent) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(agent))) throw new Error('Agentes inválidos.');
  return {
    agents,
    providers: Object.fromEntries(Object.entries(keys).map(([provider, values]) => [provider, {
      keyCount: values.length,
      profileIds: values.map((_, index) => `${provider}:vvc-key-${String(index + 1).padStart(2, '0')}`),
    }])),
    quotaPolicy: 'Perfis distintos isolam falhas de autenticação; cotas compartilhadas por projeto ou organização continuam compartilhadas. A origem de cada chave não foi comprovada.',
  };
}
function importKey({ bin, agent, provider, profileId, key }) {
  return new Promise((accept, reject) => {
    const child = spawn(bin, ['models', 'auth', 'paste-token', '--agent', agent, '--provider', provider, '--profile-id', profileId], { shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('AUTH_IMPORT_TIMEOUT')); }, 30_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('AUTH_IMPORT_START')); });
    child.once('close', (code) => { clearTimeout(timer); if (code === 0) accept(); else reject(new Error('AUTH_IMPORT_FAILED')); });
    child.stdin.on('error', () => { /* close/error determine the final outcome */ });
    child.stdin.end(`${key}\n`);
  });
}
async function main() {
  const args = process.argv.slice(2); const apply = args.includes('--apply');
  let sourcePath = resolve(ROOT, 'add_keys.sh'); let agents = ['main', 'vvc-research', 'vvc-editor', 'vvc-ops'];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' || args[i] === '--check') continue;
    if (args[i] === '--source' && args[i + 1]) { sourcePath = resolve(args[++i]); continue; }
    if (args[i] === '--agents' && args[i + 1]) { agents = [...new Set(args[++i].split(','))]; continue; }
    throw new Error('INVALID_ARGUMENTS');
  }
  const source = await readFile(sourcePath, 'utf8'); const keys = extractProviderKeys(source); const plan = profileImportPlan(keys, agents);
  if (Object.values(keys).some((values) => !values.length || values.length > 6)) throw new Error('AUTH_SOURCE_COUNTS_INVALID');
  if (!apply) { console.log(JSON.stringify({ mode: 'dry-run', ...plan }, null, 2)); return; }
  // --apply is an explicit separate step for the root after reviewing dry-run.
  // Tokens go to stdin, never command arguments or subprocess logs.
  let imported = 0;
  for (const agent of agents) for (const [provider, values] of Object.entries(keys)) for (let i = 0; i < values.length; i++) {
    await importKey({ bin: process.env.OPENCLAW_BIN || 'openclaw', agent, provider, profileId: plan.providers[provider].profileIds[i], key: values[i] }); imported++;
  }
  console.log(JSON.stringify({ mode: 'applied', imported, ...plan }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ error: 'AUTH_PROFILE_STAGE_FAILED', message: 'Falha ao preparar/importar os perfis. Não foram expostos dados de credenciais.' })); process.exitCode = 1; });
}
