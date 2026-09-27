import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMetaProvider } from './providers/meta.js';
import { createAIProvider } from './providers/ai.js';
import { createOpenClawProvider } from './providers/openclaw.js';
import { loadConfig, publicConfig } from './config.js';
import { openDatabase, createStore } from './db.js';
import { createDailyBatch, publishDue, handleApprovalCommand } from './workflow.js';
import { createBridgeServer } from './server.js';
import { aiReady, workerTick, createSerialLoop } from './worker.js';
import { createResearch, createVerifier } from './production.js';
import { runScraplingProfiles } from './research.js';
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
  if (command === 'scrapling-status') {
    const result = await runScraplingProfiles({ pythonBin: config.scraplingPython, scriptPath: resolve(process.cwd(), 'scripts/scrapling-sources.py'), timeoutMs: config.scraplingTimeoutMs });
    console.log(JSON.stringify({ ok: true, profiles: result.profiles?.length || 0, topics: (result.profiles || []).reduce((sum, item) => sum + (item.topics?.length || 0), 0), sources: (result.profiles || []).map((item) => ({ source: item.source, status: item.status, topics: item.topics?.length || 0 })), warnings: result.warnings || [] }, null, 2));
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
    if (command === 'queue') { console.log(JSON.stringify(store.queue(), null, 2)); return; }
    if (command === 'insights') {
      const latest = store.latestEvent('meta_insights_sync');
      console.log(JSON.stringify({ latestSync: latest ? { createdAt: latest.created_at, payload: JSON.parse(latest.payload_json || '{}') } : null, topPosts: store.performanceProfiles(20) }, null, 2));
      return;
    }
    if (command === 'insights-debug') {
      const failed = db.prepare("SELECT payload_json,created_at FROM events WHERE type='meta_insights_post_failed' ORDER BY id DESC LIMIT 20").all().map((row) => ({ createdAt: row.created_at, payload: JSON.parse(row.payload_json || '{}') }));
      const posts = db.prepare("SELECT id,headline,meta_post_id,meta_photo_id,published_at FROM posts WHERE status='published' ORDER BY published_at DESC LIMIT 20").all();
      console.log(JSON.stringify({ failed, posts }, null, 2));
      return;
    }
    if (command === 'meta-probe') {
      const post = db.prepare("SELECT meta_post_id,meta_photo_id FROM posts WHERE status='published' AND meta_post_id IS NOT NULL ORDER BY published_at DESC LIMIT 1").get();
      if (!post) throw new Error('Nenhum post publicado com ID Meta disponível.');
      const meta = createMetaProvider(config);
      console.log(JSON.stringify(await meta.diagnosePostPerformance({ postId: post.meta_post_id, photoId: post.meta_photo_id, pageToken: config.metaPageToken }), null, 2));
      return;
    }
    if (command === 'coverage') {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const base = new Date(`${today}T12:00:00Z`);
      const days = Array.from({ length: (config.coverageDaysAhead ?? 2) + 1 }, (_, index) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + index); return d.toISOString().slice(0, 10); });
      console.log(JSON.stringify(days.map((day) => store.dayCoverage(day)), null, 2)); return;
    }
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
