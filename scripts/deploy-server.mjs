#!/usr/bin/env node
// scripts/deploy-server.mjs — Sincroniza código e reinicia o worker no servidor
// Uso: npm run server:deploy [-- --dry-run]

import { loadConfig } from '../src/config.js';
import { deployToServer } from '../src/server-monitor.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const localDir = resolve(__dirname, '..');

const serverConfig = {
  sshKey: process.env.VVC_SSH_KEY || '~/Desktop/OpenClaw/ssh-key-2026-08-20.key',
  sshHost: process.env.VVC_SSH_HOST || 'ubuntu@161.153.125.141',
  remoteDir: process.env.VVC_REMOTE_DIR || '/home/ubuntu/vocevaiconhecer',
  localDir,
};

const dryRun = process.argv.includes('--dry-run');
const b = (text) => `\x1b[1m${text}\x1b[0m`;
const g = '\x1b[32m✓\x1b[0m';
const r = '\x1b[31m✗\x1b[0m';

if (dryRun) {
  console.log(`\n${b('Modo dry-run — nenhuma alteração será feita')}\n`);
  console.log(`  Local:   ${serverConfig.localDir}`);
  console.log(`  Remoto:  ${serverConfig.sshHost}:${serverConfig.remoteDir}`);
  console.log(`  Chave:   ${serverConfig.sshKey}`);
  console.log(`\n  Arquivos excluídos do sync: node_modules, .env, data, output, .git, .DS_Store, *.sqlite3, .bridge-token, .runtime\n`);
  process.exit(0);
}

try {
  console.log(`\n${b('═══ Deploy para o Servidor ═══')}\n`);
  console.log(`  ${serverConfig.localDir} → ${serverConfig.sshHost}:${serverConfig.remoteDir}\n`);

  const result = await deployToServer(serverConfig);

  for (const step of result.steps) {
    const icon = step.ok ? g : r;
    const detail = step.ok
      ? (step.files ? `${step.files} arquivos sincronizados` : step.status || step.output || 'OK')
      : step.error;
    console.log(`  ${icon} ${step.step}: ${detail}`);
  }

  const allOk = result.steps.every((s) => s.ok);
  console.log(`\n  Deploy ${allOk ? 'concluído com sucesso' : 'concluído com erros'} em ${result.syncedAt}\n`);
  process.exit(allOk ? 0 : 1);
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exit(1);
}
