#!/usr/bin/env node
// scripts/check-server.mjs — Verifica o estado do servidor OpenClaw/VVC
// Uso: npm run server:check [-- --json]

import { loadConfig } from '../src/config.js';
import { checkServer } from '../src/server-monitor.js';

const config = loadConfig();
const serverConfig = {
  sshKey: process.env.VVC_SSH_KEY || '~/Desktop/OpenClaw/ssh-key-2026-08-20.key',
  sshHost: process.env.VVC_SSH_HOST || 'ubuntu@161.153.125.141',
  remoteDir: process.env.VVC_REMOTE_DIR || '/home/ubuntu/vocevaiconhecer',
};

const jsonMode = process.argv.includes('--json');

try {
  const report = await checkServer(serverConfig);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  // Pretty output
  const g = '\x1b[32m✓\x1b[0m';
  const r = '\x1b[31m✗\x1b[0m';
  const y = '\x1b[33m⚠\x1b[0m';
  const b = (text) => `\x1b[1m${text}\x1b[0m`;

  console.log(`\n${b('═══ Relatório do Servidor VVC ═══')}\n`);
  console.log(`  Servidor:  ${report.server}`);
  console.log(`  Horário:   ${report.checkedAt}`);
  console.log(`  Status:    ${report.ok ? `${g} Tudo OK` : `${r} ${report.issues.length} problema(s)`}\n`);

  // Gateway
  const gw = report.gateway;
  console.log(`  ${b('OpenClaw Gateway')}`);
  console.log(`    ${gw.running ? g : r} ${gw.running ? 'Rodando' : 'Parado'} — v${gw.version}${gw.pid ? ` (pid ${gw.pid})` : ''}`);

  // Worker
  const wk = report.worker;
  console.log(`  ${b('Worker VVC')}`);
  console.log(`    ${wk.running ? g : r} ${wk.running ? `Rodando${wk.pid ? ` (pid ${wk.pid})` : ''}` : 'Parado'}`);

  // Service
  const svc = report.service;
  console.log(`  ${b('Serviço systemd')}`);
  console.log(`    ${svc.status === 'active' ? g : y} ${svc.status}`);

  // Database
  const db = report.database;
  console.log(`  ${b('Banco de Dados')}`);
  console.log(`    ${db.exists ? g : y} ${db.exists ? 'SQLite encontrado' : 'Não encontrado'}`);

  // Plugin
  const pl = report.plugin;
  console.log(`  ${b('Plugin vvc-auto-post')}`);
  console.log(`    ${pl.loaded ? g : r} ${pl.loaded ? `Carregado v${pl.version}` : 'Não carregado'}`);

  // WhatsApp
  const wa = report.whatsapp;
  console.log(`  ${b('WhatsApp')}`);
  console.log(`    ${wa.connected ? g : y} ${wa.connected ? 'Conectado' : 'Desconectado ou indisponível'}`);

  // Codex
  if (report.codex.length) {
    console.log(`  ${b('Codex/IA')}`);
    for (const s of report.codex) {
      const pct = s.percentUsed != null ? `${s.percentUsed}% usado` : 'sem dados';
      const remain = s.remainingTokens != null ? `${(s.remainingTokens / 1000).toFixed(0)}k restantes` : '';
      console.log(`    ${g} ${s.agent} (${s.model}) — ${pct}${remain ? `, ${remain}` : ''}`);
    }
  }

  // System
  const sys = report.system;
  if (sys && !sys.error) {
    console.log(`  ${b('Sistema')}`);
    console.log(`    Disco:     ${sys.disk.used}/${sys.disk.total} (${sys.disk.usePercent} usado)`);
    console.log(`    Memória:   ${sys.memory}`);
    console.log(`    Uptime:    desde ${sys.uptime}`);
  }

  // Latest batch
  const batch = report.latestBatch;
  if (batch && batch.status !== 'unavailable' && batch.status !== 'none') {
    console.log(`  ${b('Último Lote')}`);
    console.log(`    Status: ${batch.status} | ID: ${batch.id || 'n/a'}`);
  }

  // Issues
  if (report.issues.length) {
    console.log(`\n  ${b('Problemas encontrados:')}`);
    for (const issue of report.issues) console.log(`    ${r} ${issue}`);
  }

  console.log('');
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(jsonMode ? JSON.stringify({ error: error.code || 'CHECK_FAILED', message: error.message }) : `Erro: ${error.message}`);
  process.exit(1);
}
