import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function openDatabase(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(resolve(dataDir, 'vvc.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL,
      approved_at TEXT, paused_at TEXT, warning TEXT
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), slot INTEGER NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('curiosity','news')), topic TEXT NOT NULL,
      version TEXT NOT NULL, headline TEXT NOT NULL, caption TEXT NOT NULL,
      image_path TEXT, sources_json TEXT NOT NULL, trend_json TEXT NOT NULL,
      status TEXT NOT NULL, approved_at TEXT, scheduled_at TEXT, published_at TEXT,
      meta_photo_id TEXT, meta_post_id TEXT, last_error TEXT,
      UNIQUE(batch_id, slot), UNIQUE(topic, version)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, type TEXT NOT NULL,
      batch_id TEXT, post_id TEXT, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topic_memory (
      post_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, category TEXT NOT NULL,
      topic TEXT NOT NULL, headline TEXT NOT NULL, sources_json TEXT NOT NULL,
      remembered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_performance (
      post_id TEXT PRIMARY KEY, media_views INTEGER NOT NULL DEFAULT 0,
      unique_views INTEGER NOT NULL DEFAULT 0, reactions INTEGER NOT NULL DEFAULT 0,
      comments INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0, collected_at TEXT NOT NULL,
      FOREIGN KEY(post_id) REFERENCES posts(id)
    );
    CREATE INDEX IF NOT EXISTS posts_status_idx ON posts(status);
    CREATE INDEX IF NOT EXISTS events_batch_idx ON events(batch_id);
    CREATE INDEX IF NOT EXISTS topic_memory_remembered_idx ON topic_memory(remembered_at);
  `);
  // Additive migrations preserve existing drafts and approvals. Old publications
  // without an integrity hash stay blocked until reviewed again.
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns('batches').has('local_day')) db.exec('ALTER TABLE batches ADD COLUMN local_day TEXT');
  for (const field of ['content_hash', 'publishing_at']) {
    if (!columns('posts').has(field)) db.exec(`ALTER TABLE posts ADD COLUMN ${field} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS batches_day_idx ON batches(local_day) WHERE local_day IS NOT NULL');
  db.exec(`INSERT OR IGNORE INTO topic_memory(post_id,batch_id,category,topic,headline,sources_json,remembered_at)
    SELECT p.id,p.batch_id,p.category,p.topic,p.headline,p.sources_json,COALESCE(p.published_at,p.approved_at,b.created_at)
    FROM posts p JOIN batches b ON b.id=p.batch_id`);
  return db;
}

function json(value) { return JSON.stringify(value ?? null); }
function parse(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }

export function createStore(db) {
  const addEvent = db.prepare('INSERT INTO events(created_at,type,batch_id,post_id,payload_json) VALUES(?,?,?,?,?)');
  return {
    close() { db.close(); },
    createBatch({ id, createdAt = new Date().toISOString(), warning = null, localDay = null, status = 'draft' }) {
      this.transaction(() => {
        db.prepare('INSERT INTO batches(id,created_at,status,warning,local_day) VALUES(?,?,?,?,?)').run(id, createdAt, status, warning, localDay);
        addEvent.run(createdAt, 'batch_created', id, null, json({ warning }));
      });
      return id;
    },
    batchForDay(day) { return db.prepare('SELECT id,status FROM batches WHERE local_day=?').get(day); },
    dayCoverage(day) {
      const batch = db.prepare('SELECT id,status,created_at,warning FROM batches WHERE local_day=?').get(day);
      if (!batch) return { day, batchId: null, status: 'missing', total: 0, pending: 0, approved: 0, scheduled: 0, published: 0, rejected: 0 };
      const counts = db.prepare(`SELECT status,COUNT(*) AS count FROM posts WHERE batch_id=? GROUP BY status`).all(batch.id);
      const by = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
      return { day, batchId: batch.id, status: batch.status, createdAt: batch.created_at, warning: batch.warning, total: Object.values(by).reduce((a,b)=>a+b,0), pending: by.pending_approval || 0, approved: by.approved || 0, scheduled: by.scheduled || 0, published: by.published || 0, rejected: by.rejected || 0 };
    },
    recoverStaleGenerating(cutoffIso) {
      const rows = db.prepare("SELECT id FROM batches WHERE status='generating' AND created_at<?").all(cutoffIso);
      for (const row of rows) {
        db.prepare("UPDATE batches SET status='blocked', warning=? WHERE id=? AND status='generating'").run('Geração anterior interrompida; pronta para reparo automático.', row.id);
        addEvent.run(new Date().toISOString(), 'batch_stale_recovered', row.id, null, json({ cutoffIso }));
      }
      return rows.length;
    },
    releaseBlockedDay(day, now = new Date().toISOString()) {
      return this.transaction(() => {
        const row = db.prepare("SELECT id,status,(SELECT COUNT(*) FROM posts WHERE batch_id=batches.id) AS posts FROM batches WHERE local_day=?").get(day);
        if (!row) return { released: false, reason: 'no_batch' };
        if (!['blocked', 'generating'].includes(row.status) || row.posts !== 0) return { released: false, reason: 'not_safe', id: row.id, status: row.status, posts: row.posts };
        db.prepare('UPDATE batches SET local_day=NULL WHERE id=?').run(row.id);
        addEvent.run(now, 'batch_retry_released', row.id, null, json({ localDay: day, reason: 'manual_retry' }));
        return { released: true, id: row.id, day };
      });
    },
    removeRejectedSlot(batchId, slot) {
      return this.transaction(() => {
        const row = db.prepare("SELECT id FROM posts WHERE batch_id=? AND slot=? AND status='rejected'").get(batchId, slot);
        if (!row) return false;
        addEvent.run(new Date().toISOString(), 'post_replacement_started', batchId, row.id, json({ slot }));
        db.prepare("DELETE FROM posts WHERE id=? AND status='rejected'").run(row.id);
        return true;
      });
    },
    insertPost(post) {
      this.transaction(() => {
        const rememberedAt = new Date().toISOString();
        db.prepare(`INSERT INTO posts
          (id,batch_id,slot,category,topic,version,headline,caption,image_path,sources_json,trend_json,status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          post.id, post.batchId, post.slot, post.category, post.topic, post.version,
          post.headline, post.caption, post.imagePath || null, json(post.sources), json(post.trend), post.status || 'pending_approval',
        );
        if (post.contentHash) db.prepare('UPDATE posts SET content_hash=? WHERE id=?').run(post.contentHash, post.id);
        db.prepare(`INSERT OR REPLACE INTO topic_memory
          (post_id,batch_id,category,topic,headline,sources_json,remembered_at) VALUES(?,?,?,?,?,?,?)`)
          .run(post.id, post.batchId, post.category, post.topic, post.headline, json(post.sources), rememberedAt);
        addEvent.run(rememberedAt, 'post_created', post.batchId, post.id, json({ version: post.version }));
      });
    },
    topicMemory() {
      return db.prepare('SELECT * FROM topic_memory ORDER BY remembered_at DESC').all()
        .map((row) => ({ ...row, sources: parse(row.sources_json, []) }));
    },
    latestEvent(type) {
      return db.prepare('SELECT * FROM events WHERE type=? ORDER BY id DESC LIMIT 1').get(type) || null;
    },
    publishedForInsights(limit = 100) {
      return db.prepare(`SELECT id,meta_post_id,meta_photo_id,published_at FROM posts
        WHERE status='published' AND published_at IS NOT NULL AND (meta_post_id IS NOT NULL OR meta_photo_id IS NOT NULL)
        ORDER BY published_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit)));
    },
    performanceProfiles(limit = 20) {
      return db.prepare(`SELECT p.id AS post_id,p.category,p.topic,p.headline,p.published_at,pp.media_views,pp.unique_views,pp.reactions,pp.comments,pp.shares,pp.score,pp.collected_at
        FROM post_performance pp JOIN posts p ON p.id=pp.post_id
        WHERE p.status='published' ORDER BY pp.score DESC,pp.collected_at DESC LIMIT ?`).all(Math.max(1, Math.min(100, limit)));
    },
    savePostPerformance(postId, metrics, collectedAt = new Date().toISOString()) {
      const mediaViews = Math.max(0, Number(metrics.mediaViews || 0));
      const uniqueViews = Math.max(0, Number(metrics.uniqueViews || 0));
      const reactions = Math.max(0, Number(metrics.reactions || 0));
      const comments = Math.max(0, Number(metrics.comments || 0));
      const shares = Math.max(0, Number(metrics.shares || 0));
      const score = Math.log10(1 + mediaViews) + Math.log10(1 + uniqueViews) + 1.4 * Math.log10(1 + reactions + 2 * comments + 3 * shares);
      db.prepare(`INSERT INTO post_performance(post_id,media_views,unique_views,reactions,comments,shares,score,collected_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET media_views=excluded.media_views,unique_views=excluded.unique_views,reactions=excluded.reactions,comments=excluded.comments,shares=excluded.shares,score=excluded.score,collected_at=excluded.collected_at`)
        .run(postId, mediaViews, uniqueViews, reactions, comments, shares, score, collectedAt);
      return { postId, mediaViews, uniqueViews, reactions, comments, shares, score, collectedAt };
    },
    getBatch(id) {
      const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(id);
      if (!batch) return null;
      const posts = db.prepare('SELECT * FROM posts WHERE batch_id=? ORDER BY slot').all(id).map((post) => ({
        ...post, sources: parse(post.sources_json, []), trend: parse(post.trend_json, {}),
      }));
      return { ...batch, posts };
    },
    latestBatch() { const row = db.prepare('SELECT id FROM batches ORDER BY created_at DESC LIMIT 1').get(); return row ? this.getBatch(row.id) : null; },
    queue() {
      return db.prepare(`SELECT p.id,p.batch_id,p.slot,p.category,p.headline,p.status,p.approved_at,p.scheduled_at,p.published_at,b.status AS batch_status,b.local_day
        FROM posts p JOIN batches b ON b.id=p.batch_id
        WHERE p.status IN ('approved','scheduled','publishing','published','publication_unknown')
        ORDER BY COALESCE(p.scheduled_at,'9999-12-31'),b.created_at,p.slot`).all();
    },
    getPost(id) { const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id); return row ? { ...row, sources: parse(row.sources_json, []), trend: parse(row.trend_json, {}) } : null; },
    approvalCode(id) {
      const row = db.prepare("SELECT id FROM events WHERE type='post_created' AND post_id=? ORDER BY id LIMIT 1").get(id);
      return row ? String(row.id).padStart(4, '0') : null;
    },
    findPostByApprovalCode(code) {
      const row = db.prepare(`SELECT p.* FROM events e JOIN posts p ON p.id=e.post_id
        WHERE e.id=? AND e.type='post_created' LIMIT 1`).get(Number(code));
      return row ? { ...row, sources: parse(row.sources_json, []), trend: parse(row.trend_json, {}) } : null;
    },
    findPostsByVersionPrefix(prefix) {
      return db.prepare('SELECT * FROM posts WHERE version LIKE ? ORDER BY rowid DESC LIMIT 2').all(`${prefix}%`)
        .map((row) => ({ ...row, sources: parse(row.sources_json, []), trend: parse(row.trend_json, {}) }));
    },
    setBatchStatus(id, status, extra = {}) {
      const fields = ['status=?']; const values = [status];
      for (const key of ['approved_at', 'paused_at', 'warning']) if (key in extra) { fields.push(`${key}=?`); values.push(extra[key]); }
      values.push(id); db.prepare(`UPDATE batches SET ${fields.join(',')} WHERE id=?`).run(...values);
      addEvent.run(new Date().toISOString(), `batch_${status}`, id, null, json(extra));
    },
    approvePost(id, now = new Date().toISOString(), expected = null) {
      const post = this.getPost(id);
      if (!post) return null;
      const result = db.prepare(`UPDATE posts SET status='approved', approved_at=?, last_error=NULL
        WHERE id=? AND status IN ('pending_approval','rejected')
        ${expected ? 'AND version=? AND content_hash=? AND headline=? AND caption=? AND sources_json=? AND image_path=?' : ''}`)
        .run(now, id, ...(expected ? [expected.version, expected.content_hash, expected.headline, expected.caption, expected.sources_json, expected.image_path] : []));
      if (!result.changes) return null;
      addEvent.run(now, 'post_approved', post.batch_id, id, json({ version: post.version }));
      return this.getPost(id);
    },
    rejectPost(id, reason = 'Rejeitado pelo usuário') {
      const post = this.getPost(id); if (!post) return null;
      const result = db.prepare("UPDATE posts SET status='rejected', last_error=?,approved_at=NULL,scheduled_at=NULL WHERE id=? AND status IN ('pending_approval','approved','scheduled')").run(reason, id);
      if (!result.changes) return null;
      addEvent.run(new Date().toISOString(), 'post_rejected', post.batch_id, id, json({ reason }));
      return this.getPost(id);
    },
    markScheduled(id, at) { db.prepare("UPDATE posts SET status='scheduled',scheduled_at=? WHERE id=? AND status='approved'").run(at, id); },
    reschedule(id, at) { db.prepare("UPDATE posts SET scheduled_at=? WHERE id=? AND status='scheduled'").run(at, id); },
    reservedTimes(excludeIds = []) {
      return db.prepare("SELECT id,scheduled_at FROM posts WHERE status IN ('scheduled','publishing','published','publication_unknown') AND scheduled_at IS NOT NULL").all().filter((row) => !excludeIds.includes(row.id)).map((row) => row.scheduled_at);
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    claimPublication(id, now, earliest, spacingCutoff, expected) {
      // One atomic durable claim, including batch state, approval and global
      // spacing. A crash leaves 'publishing': never retry that post blindly.
      return Boolean(db.prepare(`UPDATE posts SET status='publishing',publishing_at=?
        WHERE id=? AND status='scheduled' AND approved_at IS NOT NULL
        AND content_hash IS NOT NULL
        AND version=? AND content_hash=? AND headline=? AND caption=? AND sources_json=? AND image_path=? AND scheduled_at=?
        AND julianday(scheduled_at)<=julianday(?) AND julianday(scheduled_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM batches WHERE batches.id=posts.batch_id AND batches.status='scheduled')
        AND NOT EXISTS(SELECT 1 FROM posts p WHERE p.status='publishing'
          OR (p.publishing_at IS NOT NULL AND julianday(p.publishing_at)>julianday(?)))`)
        .run(now, id, expected.version, expected.content_hash, expected.headline, expected.caption, expected.sources_json, expected.image_path, expected.scheduled_at, now, earliest, spacingCutoff).changes);
    },
    invalidatePost(id, reason) { db.prepare("UPDATE posts SET status='pending_approval',approved_at=NULL,scheduled_at=NULL,last_error=? WHERE id=? AND status='scheduled'").run(reason, id); },
    markPublished(id, result, now = new Date().toISOString()) { db.prepare("UPDATE posts SET status='published',published_at=?,meta_photo_id=?,meta_post_id=?,last_error=NULL WHERE id=? AND status='publishing'").run(now, result.id, result.postId ?? null, id); },
    markUnknown(id, error) { db.prepare("UPDATE posts SET status='publication_unknown',last_error=? WHERE id=? AND status='publishing'").run(error, id); },
    markFailed(id, error) { db.prepare("UPDATE posts SET status='publication_failed',last_error=? WHERE id=? AND status='publishing'").run(error, id); },
    listReady() { return db.prepare("SELECT id FROM posts WHERE status IN ('approved','scheduled') ORDER BY scheduled_at,slot").all().map(({ id }) => this.getPost(id)); },
    addEvent(type, { batchId = null, postId = null, ...payload } = {}) { addEvent.run(new Date().toISOString(), type, batchId, postId, json(payload)); },
  };
}
