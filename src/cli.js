import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createMetaProvider } from './providers/meta.js';
import { createAIProvider } from './providers/ai.js';
import { createOpenClawProvider } from './providers/openclaw.js';
import { loadConfig, publicConfig } from './config.js';
import { openDatabase, createStore } from './db.js';
import { createDailyBatch, publishDue, scheduleBatch, handleApprovalCommand } from './workflow.js';
import { createBridgeServer } from './server.js';

const config = loadConfig();
const command = process.argv[2] || 'doctor';

function localDay(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function pastGenerationTime(date, timezone, generationTime) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const [targetHour, targetMinute] = String(generationTime || '08:00').split(':').map(Number);
  return hour * 60 + minute >= (targetHour * 60 + targetMinute);
}

function aiReady(config) {
  return config.openclawAiEnabled || (config.aiFreeTierConfirmed && config.cfAccountId && config.cfApiToken);
}

async function workerTick({ config, store }) {
  const now = new Date();
  if (config.metaPublishEnabled) {
    try { const meta = createMetaProvider(config); await publishDue({ store, meta, config, now }); }
    catch (error) { console.error(JSON.stringify({ error: error.code || 'META_ERROR', message: error.message })); }
  }
  const latest = store.latestBatch();
  const generatedToday = latest && localDay(new Date(latest.created_at), config.timezone) === localDay(now, config.timezone);
  if (!generatedToday && pastGenerationTime(now, config.timezone, config.generationTime) && aiReady(config)) {
    try {
      const result = await createDailyBatch({ config, store, ai: createAIProvider(config), messenger: createOpenClawProvider(config), now });
      console.log(JSON.stringify({ worker: 'batch_created', ...result }));
    } catch (error) { console.error(JSON.stringify({ error: error.code || 'BATCH_ERROR', message: error.message })); }
  }
}

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  if (command === 'doctor') {
    console.log(JSON.stringify({ ok: true, config: publicConfig(config), node: process.version, researchScript: existsSync(`${config.last30daysDir}/vendor/last30days/skills/last30days/scripts/last30days.py`) }, null, 2));
    return;
  }
  const db = await openDatabase(config.dataDir); const store = createStore(db);
  try {
    if (command === 'status') { console.log(JSON.stringify(store.latestBatch() || { status: 'none' }, null, 2)); return; }
    if (command === 'batch') {
      if (!aiReady(config)) throw new Error('Configure o provedor de IA no .env antes de gerar o lote.');
      const ai = createAIProvider(config); const messenger = createOpenClawProvider(config); const meta = createMetaProvider(config);
      const result = await createDailyBatch({ config, store, ai, messenger });
      console.log(JSON.stringify(result, null, 2));
      if (!config.approvalRequired) { const scheduled = scheduleBatch({ store, config, batchId: result.batchId }); console.log(JSON.stringify(scheduled)); }
      return;
    }
    if (command === 'publish') { const meta = createMetaProvider(config); console.log(JSON.stringify(await publishDue({ store, meta, config }), null, 2)); return; }
    if (command === 'serve') {
      const server = createBridgeServer({ config, handleCommand: async (payload) => handleApprovalCommand({ ...payload, config, store }) });
      const port = Number(process.env.VVC_PORT || 8790); server.listen(port, '127.0.0.1', () => console.log(`vvc bridge listening on 127.0.0.1:${port}`));
      const shutdown = () => { server.close(() => { store.close(); process.exit(0); }); }; process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); return;
    }
    if (command === 'worker') {
      const server = createBridgeServer({ config, handleCommand: async (payload) => handleApprovalCommand({ ...payload, config, store }) });
      const port = Number(process.env.VVC_PORT || 8790);
      server.listen(port, '127.0.0.1', () => console.log(`vvc worker listening on 127.0.0.1:${port}`));
      await workerTick({ config, store });
      const interval = setInterval(() => workerTick({ config, store }).catch((error) => console.error(JSON.stringify({ error: error.code || 'WORKER_ERROR', message: error.message }))), 60_000);
      const shutdown = () => { clearInterval(interval); server.close(() => { store.close(); process.exit(0); }); };
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); return;
    }
    throw new Error(`Comando desconhecido: ${command}`);
  } finally { if (!['serve', 'worker'].includes(command)) store.close(); }
}

main().catch((error) => { console.error(JSON.stringify({ error: error.code || 'VVC_ERROR', message: error.message })); process.exitCode = 1; });
