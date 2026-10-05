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
import { aiReady, workerTick, createSerialLoop, syncMetaInsights } from './worker.js';
import { createResearch, createVerifier } from './production.js';
import { runScraplingProfiles } from './research.js';
import { createPreview } from './preview.js';
import { fileURLToPath } from 'node:url';
import { startTask, taskStatus, parseTaskArguments } from './task-runner.js';
import { createTopicPlan, listTopicPlans, loadTopicPlan, approveTopicPlan, researchForApprovedPlan, formatTopicPlanMessages, markTopicPlanConsumed } from './topic-plan.js';

// Callers such as the WhatsApp agent may run `node src/cli.js ...` without
// --env-file and from another directory. Always anchor to the project root and
// load its .env; variables already present in the environment take precedence.
const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(PROJECT_ROOT);
if (existsSync(resolve(PROJECT_ROOT, '.env'))) {
  try { process.loadEnvFile(resolve(PROJECT_ROOT, '.env')); } catch { /* keep explicit environment */ }
}

const config = loadConfig();
const command = process.argv[2] || 'doctor';
const taskProgress = (event) => {
  const type = typeof event?.type === 'string' && /^[a-z_]{1,64}$/.test(event.type) ? event.type : 'research_activity';
  const progress = { type };
  for (const key of ['candidates', 'eligible', 'slot']) if (Number.isSafeInteger(event?.[key]) && event[key] >= 0) progress[key] = event[key];
  if (typeof event?.code === 'string' && /^[A-Z_]{1,80}$/.test(event.code)) progress.code = event.code;
  console.error(JSON.stringify({ taskProgress: progress }));
};

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  if (command === 'task') {
    console.log(JSON.stringify(await startTask({ config, command: process.argv[3], args: process.argv.slice(4) }), null, 2));
    return;
  }
  if (command === 'task-status' || command === 'task-check') {
    console.log(JSON.stringify(await taskStatus({ config, id: process.argv[3] }), null, 2));
    return;
  }
  if (command === 'themes') {
    const plan = process.argv[3] ? await loadTopicPlan({ config, id: process.argv[3] }) : (await listTopicPlans({ config }))[0];
    console.log(JSON.stringify(plan ? { planId: plan.id, targetDay: plan.targetDay, status: plan.status, approvedIndices: plan.approvedIndices, messages: formatTopicPlanMessages(plan) } : { status: 'none' }, null, 2)); return;
  }
  if (command === 'themes-approve') {
    const plan = await approveTopicPlan({ config, id: process.argv[3], selection: process.argv[4] });
    console.log(JSON.stringify({ planId: plan.id, status: plan.status, approvedIndices: plan.approvedIndices }, null, 2)); return;
  }
  if (command === 'doctor') {
    console.log(JSON.stringify({ ok: true, config: publicConfig(config), node: process.version, researchScript: existsSync(`${config.last30daysDir}/vendor/last30days/skills/last30days/scripts/last30days.py`) }, null, 2));
    return;
  }
  if (command === 'research') {
    const options = parseTaskArguments('research', process.argv.slice(3));
    const result = await createResearch(config, { discoverOnly: options.discoverOnly })(config, { onProgress: taskProgress });
    const warnings = [...(result.warnings || [])];
    let plan;
    const researchDb = await openDatabase(config.dataDir); const researchStore = createStore(researchDb);
    try { plan = await createTopicPlan({ config, store: researchStore, result, targetDay: options.targetDay }); }
    catch (error) { if (error.code !== 'TOPIC_PLAN_EMPTY') throw error; warnings.push({ code: 'TOPIC_PLAN_EMPTY' }); }
    finally { researchStore.close(); }
    const messenger = createOpenClawProvider(config);
    for (const text of plan ? formatTopicPlanMessages(plan) : []) {
      try { await messenger.send({ text }); }
      catch { warnings.push({ code: 'TOPIC_PLAN_DELIVERY_UNCONFIRMED' }); break; }
    }
    console.log(JSON.stringify({ reportPath: result.reportPath, counts: result.counts, warnings, windowDays: result.windowDays, planId: plan?.id || null, topicCount: plan?.items?.length || 0, targetDay: plan?.targetDay || options.targetDay, status: plan?.status || 'empty' }, null, 2));
    return;
  }
  if (command === 'scrapling-status') {
    const result = await runScraplingProfiles({ pythonBin: config.scraplingPython, scriptPath: fileURLToPath(new URL('../scripts/scrapling-sources.py', import.meta.url)), timeoutMs: config.scraplingTimeoutMs });
    console.log(JSON.stringify({ ok: true, profiles: result.profiles?.length || 0, topics: (result.profiles || []).reduce((sum, item) => sum + (item.topics?.length || 0), 0), sources: (result.profiles || []).map((item) => ({ source: item.source, status: item.status, topics: item.topics?.length || 0 })), warnings: result.warnings || [] }, null, 2));
    return;
  }
  if (command === 'preview') {
    const input = process.argv[3];
    let isTooBig = false; try { isTooBig = (await stat(input)).size > 1_000_000; } catch { isTooBig = true; }
    if (!input || input.startsWith('--') || isTooBig) throw new Error('Use preview <arquivo-candidato.json> [--send], com JSON existente de até 1 MB.');
    const candidate = JSON.parse(await readFile(input, 'utf8'));
    const result = await createPreview({ config, candidate, ai: createAIProvider(config), verifyImpl: createVerifier(config), messenger: process.argv.includes('--send') ? createOpenClawProvider(config) : undefined });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const db = await openDatabase(config.dataDir); const store = createStore(db);
  try {
    if (command === 'status') { console.log(JSON.stringify(store.latestBatch() || { status: 'none' }, null, 2)); return; }
    if (command === 'queue') { console.log(JSON.stringify(store.queue(), null, 2)); return; }
    if (command === 'insights-sync') {
      const meta = createMetaProvider(config);
      console.log(JSON.stringify(await syncMetaInsights({ store, meta, config, minIntervalMs: 0 }), null, 2));
      return;
    }
    if (command === 'insights') {
      const latest = store.latestEvent('meta_insights_sync');
      const historicalTop10 = store.historicalPerformanceProfiles?.(10) || [];
      console.log(JSON.stringify({ latestSync: latest ? { createdAt: latest.created_at, payload: JSON.parse(latest.payload_json || '{}') } : null, historicalTop10, activeTop5: historicalTop10.slice(0, 5), localTopPosts: store.performanceProfiles(20) }, null, 2));
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
      const { targetDay, planId } = parseTaskArguments('batch', process.argv.slice(3));
      const approvedPlan = await loadTopicPlan({ config, id: planId });
      const snapshot = researchForApprovedPlan(approvedPlan, { config });
      if (targetDay && targetDay !== approvedPlan.targetDay) throw Object.assign(new Error('O dia solicitado difere do plano de temas aprovado.'), { code: 'TOPIC_PLAN_DAY_MISMATCH' });
      if (!aiReady(config)) throw new Error('Configure o provedor de IA no .env antes de gerar o lote.');
      const ai = createAIProvider(config); const messenger = createOpenClawProvider(config);
      const result = await createDailyBatch({ config, store, ai, messenger, research: async () => snapshot, targetDay: approvedPlan.targetDay, approvedPlan, onProgress: taskProgress, notifyProgress: process.env.VVC_TASK_MANAGED !== '1' });
      if (result.topicPlanCompleted === true) await markTopicPlanConsumed({ config, id: planId });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === 'publish') { const meta = createMetaProvider(config); console.log(JSON.stringify(await publishDue({ store, meta, config }), null, 2)); return; }
    if (command === 'serve') {
      const server = createBridgeServer({ config, handleCommand: async (payload) => handleApprovalCommand({ ...payload, config, store }) });
      const portEnv = Number(process.env.VVC_PORT); const port = Number.isFinite(portEnv) ? portEnv : 8790; server.listen(port, '127.0.0.1', () => console.log(`vvc bridge listening on 127.0.0.1:${port}`));
      const shutdown = () => { server.close(() => { store.close(); process.exit(0); }); }; process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); return;
    }
    if (command === 'worker') {
      const server = createBridgeServer({ config, handleCommand: async (payload) => handleApprovalCommand({ ...payload, config, store }) });
      const portEnv = Number(process.env.VVC_PORT); const port = Number.isFinite(portEnv) ? portEnv : 8790;
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
