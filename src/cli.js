import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createMetaProvider } from './providers/meta.js';
import { createAIProvider } from './providers/ai.js';
import { createOpenClawProvider } from './providers/openclaw.js';
import { loadConfig, publicConfig } from './config.js';
import { openDatabase, createStore } from './db.js';
import { createDailyBatch, publishDue, handleApprovalCommand } from './workflow.js';
import { createBridgeServer } from './server.js';
import { aiReady, workerTick, createSerialLoop } from './worker.js';
import { createResearch, createVerifier } from './production.js';
import { createPreview } from './preview.js';

const config = loadConfig();
const command = process.argv[2] || 'doctor';

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  if (command === 'doctor') {
    console.log(JSON.stringify({ ok: true, config: publicConfig(config), node: process.version, researchScript: existsSync(`${config.last30daysDir}/vendor/last30days/skills/last30days/scripts/last30days.py`) }, null, 2));
    return;
  }
  if (command === 'research') {
    const result = await createResearch(config, { discoverOnly: process.argv.includes('--discover-only') })(config);
    console.log(JSON.stringify({ reportPath: result.reportPath, counts: result.counts, warnings: result.warnings, windowDays: result.windowDays }, null, 2));
    return;
  }
  if (command === 'preview') {
    const input = process.argv[3];
    if (!input || input.startsWith('--') || (await stat(input)).size > 1_000_000) throw new Error('Use preview <arquivo-candidato.json> [--send], com JSON de até 1 MB.');
    const candidate = JSON.parse(await readFile(input, 'utf8'));
    const result = await createPreview({ config, candidate, ai: createAIProvider(config), verifyImpl: createVerifier(config), messenger: process.argv.includes('--send') ? createOpenClawProvider(config) : undefined });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const db = await openDatabase(config.dataDir); const store = createStore(db);
  try {
    if (command === 'status') { console.log(JSON.stringify(store.latestBatch() || { status: 'none' }, null, 2)); return; }
    if (command === 'retry-today') {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      console.log(JSON.stringify(store.releaseBlockedDay(day), null, 2));
      return;
    }
    if (command === 'batch') {
      if (!aiReady(config)) throw new Error('Configure o provedor de IA no .env antes de gerar o lote.');
      const ai = createAIProvider(config); const messenger = createOpenClawProvider(config);
      const result = await createDailyBatch({ config, store, ai, messenger, research: createResearch(config) });
      console.log(JSON.stringify(result, null, 2));
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
      const research = createResearch(config);
      const loop = createSerialLoop(() => workerTick({ config, store, research }), { onError: (error) => console.error(JSON.stringify({ error: error.code || 'WORKER_ERROR', message: error.message })) });
      loop.start();
      const shutdown = async () => { await loop.stop(); server.close(() => { store.close(); process.exit(0); }); };
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); return;
    }
    throw new Error(`Comando desconhecido: ${command}`);
  } finally { if (!['serve', 'worker'].includes(command)) store.close(); }
}

main().catch((error) => { console.error(JSON.stringify({ error: error.code || 'VVC_ERROR', message: error.message })); process.exitCode = 1; });
