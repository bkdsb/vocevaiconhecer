import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const directory = process.argv[2] || '/private/tmp/vvc-controller';
await mkdir(directory, { recursive: true, mode: 0o700 });
const config = JSON.parse(await readFile(resolve(homedir(), '.openclaw/openclaw.json'), 'utf8'));
const chain = { primary: 'openai/gpt-6-astra', fallbacks: ['google-genai/gemini-3.8-flash', 'google-genai/gemini-3.1-flash-lite', 'openrouter/qwen/qwen3.8-27b:free', 'groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b'] };
const roles = ['main', 'vvc-research', 'vvc-editor', 'vvc-ops'];
const entries = Object.fromEntries(roles.map((id) => [id, {
  workspace: id === 'main' ? config.agents.entries.main.workspace : config.agents.entries[id]?.workspace || resolve(homedir(), `.openclaw/workspace-${id}`),
  ...(id === 'vvc-ops' ? { agentDir: resolve(homedir(), '.openclaw/agents/vvc-ops/agent') } : {}),
  model: chain, utilityModel: '', thinkingDefault: id === 'vvc-research' ? 'medium' : 'low',
  subagents: { allowAgents: id === 'main' ? roles.slice(1) : [] },
  bootstrapMaxChars: 4500, bootstrapTotalMaxChars: 5200,
  skills: [],
  tools: { profile: 'minimal', alsoAllow: id === 'main' ? ['exec', 'read', 'process', 'sessions_spawn', 'sessions_history', 'sessions_yield'] : ['exec', 'read', 'process'], codeMode: false },
  modelPolicy: { allow: [chain.primary, ...chain.fallbacks] },
}]));
const providers = {};
for (const name of ['groq', 'google-genai']) {
  if (!config.models?.providers?.[name]) continue;
  providers[name] = { models: config.models.providers[name].models.map((model) => ({ ...model, contextTokens: name === 'groq' ? 5800 : 16000, maxTokens: name === 'groq' ? 1000 : 2000 })) };
}
const models = Object.fromEntries([chain.primary, ...chain.fallbacks].map((id) => [id, { codeMode: false, params: { maxTokens: id.startsWith('groq/') ? 1000 : 2000 } }]));
models['openrouter/meta-llama/llama-3.1-70b-instruct'] = null;
providers.openrouter = { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', models: [{ id: 'qwen/qwen3.8-27b:free', name: 'Qwen Free', contextWindow: 262144, contextTokens: 16000, maxTokens: 2000 }] };
const patch = {
  messages: { visibleReplies: 'automatic' },
  bindings: (config.bindings || []).map((binding) => binding.match?.channel === 'whatsapp' && binding.match?.accountId === 'default' ? { ...binding, agentId: 'main' } : binding),
  talk: { agentId: 'main' },
  agents: { defaults: { model: chain, utilityModel: '', models, timeoutSeconds: 300, heartbeat: { every: '0m' },
    imageModel: { primary: 'openai/gpt-image-2', fallbacks: [] }, mediaModels: { image: { primary: 'openai/gpt-image-2', fallbacks: [] } },
    subagents: { maxConcurrent: 2, runTimeoutSeconds: 900, archiveAfterMinutes: 60 },
    compaction: { enabled: true, mode: 'safeguard', keepRecentTokens: 1200, recentTurnsPreserve: 3, identifierPolicy: 'strict', timeoutSeconds: 60, maxActiveTranscriptBytes: '100kb', notifyUser: false, midTurnPrecheck: { enabled: true }, memoryFlush: { enabled: false } },
  }, entries },
  tools: { agentToAgent: { enabled: true, allow: roles }, sessions: { visibility: 'tree' } },
  models: { providers },
};
await writeFile(resolve(directory, 'patch.json'), JSON.stringify(patch, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ patchPath: resolve(directory, 'patch.json'), roles, chain, cappedProviders: Object.keys(providers) }));
