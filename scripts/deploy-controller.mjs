import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const source = resolve(import.meta.dirname, '..');
const runtime = resolve(homedir(), 'vocevaiconhecer');
const stamp = new Date().toISOString().replaceAll(':', '-');
const backup = resolve(runtime, 'data/maintenance', stamp);
await mkdir(backup, { recursive: true, mode: 0o700 });
async function save(path, content) {
  try { await copyFile(path, resolve(backup, createHash('sha256').update(path).digest('hex'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
}
const controller = await readFile(resolve(source, 'integrations/openclaw/CONTROLLER.md'), 'utf8');
const workspace = JSON.parse(await readFile(resolve(homedir(), '.openclaw/openclaw.json'), 'utf8')).agents.entries.main.workspace;
const agentsPath = resolve(workspace, 'AGENTS.md');
let previous = await readFile(agentsPath, 'utf8').catch(() => '');
const marker = '\n<!-- VVC CONTROLLER END -->\n';
if (previous.includes(marker)) previous = previous.slice(previous.indexOf(marker) + marker.length);
await save(agentsPath, controller + marker + previous);
const roles = {
  'vvc-research': 'Executor de pesquisa e ranking. Colete Facebook/Scrapling e last30days, preserve URLs, texto, data real e métricas. Nunca trate coleta como publicação. Política/IA/tecnologia/militar exigem fonte <=24h; sem data bloqueie. Não publique. Use supervisor CLI para pesquisas longas. Retorne resumo curto, counts/warnings e caminho do relatório; main comunica e decide.',
  'vvc-editor': 'Executor editorial. Gere texto factual e prévias alinhadas, títulos válidos e fontes consistentes. Não invente fatos nem datas e não aprove/publica por conta própria. Faça validação antes de retornar. Retorne resultado curto/arquivo e erros explícitos para main.',
  'vvc-ops': 'Executor operacional. Consulte task-status, gateway e logs curtos/sanitizados. Diagnostique erros e confirme agendamento somente com ID Meta real. Não repita publicação/envio incerto, não contorne cotas nem altere modelos globais. Retorne diagnóstico, evidência e próximo passo para main.',
};
for (const [id, role] of Object.entries(roles)) {
  const path = resolve(homedir(), `.openclaw/workspace-${id}/AGENTS.md`);
  const instructions = `# ${id}\n\n${role}\n\nOperação: /Users/belegante/vocevaiconhecer. Responda em português. Não delegue recursivamente. Receba apenas contexto necessário, leia arquivos em trechos e não carregue relatórios/logs inteiros no prompt. Nunca exponha credenciais. Ferramentas dinâmicas: procure/descreva antes de usar ID exato. Não prometa acompanhamento futuro sem task/supervisor registrado.\n`;
  await save(path, instructions);
}
const chain = ['openai/gpt-6-astra', 'google-genai/gemini-3.8-flash', 'google-genai/gemini-3.1-flash-lite', 'openrouter/qwen/qwen3.8-27b:free', 'groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b'];
const updates = { OPENCLAW_AI_MODEL: chain[0], OPENCLAW_TEXT_MODELS: chain.join(','), VVC_CODEX_MODEL: chain[0], VVC_FREE_TEXT_MODELS: chain.slice(1).join(','), VVC_TOPIC_APPROVAL_REQUIRED: 'true', VVC_FACEBOOK_BASE_REQUIRED: 'true', SCRAPLING_FACEBOOK_PROFILE: resolve(runtime, 'data/facebook-browser') };
const envPath = resolve(runtime, '.env');
let env = await readFile(envPath, 'utf8');
for (const [key, value] of Object.entries(updates)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  env = pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`;
}
await save(envPath, env); await chmod(envPath, 0o600);
const files = ['src/config.js', 'src/cli.js', 'src/task-runner.js', 'src/topic-plan.js', 'src/worker.js', 'src/workflow.js', 'src/research.js', 'src/freshness.js', 'src/providers/ai-content.js', 'src/providers/openclaw-ai.js', 'src/providers/meta.js', 'src/db.js', 'scripts/smart-heartbeat.js', 'scripts/scrapling-sources.py', 'scripts/connect-facebook.py', 'integrations/openclaw/index.js', 'integrations/openclaw/commands.js', 'integrations/openclaw/handler.js', 'integrations/openclaw/replies.js', 'integrations/openclaw/CONTROLLER.md'];
if (!process.argv.includes('--instructions-only')) {
  for (const file of files) await save(resolve(runtime, file), await readFile(resolve(source, file)));
}
console.log(JSON.stringify({ runtime, backup, copiedFiles: process.argv.includes('--instructions-only') ? [] : files, roles: ['main', ...Object.keys(roles)], envFieldsUpdated: Object.keys(updates) }));
