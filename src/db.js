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
    CREATE INDEX IF NOT EXISTS posts_status_idx ON posts(status);
    CREATE INDEX IF NOT EXISTS events_batch_idx ON events(batch_id);
  `);
  // Additive migrations preserve existing drafts and approvals. Old publications
  // without an integrity hash stay blocked until reviewed again.
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns('batches').has('local_day')) db.exec('ALTER TABLE batches ADD COLUMN local_day TEXT');
  for (const field of ['content_hash', 'publishing_at']) {
    if (!columns('posts').has(field)) db.exec(`ALTER TABLE posts ADD COLUMN ${field} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS batches_day_idx ON batches(local_day) WHERE local_day IS NOT NULL');
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
    insertPost(post) {
      db.prepare(`INSERT INTO posts
        (id,batch_id,slot,category,topic,version,headline,caption,image_path,sources_json,trend_json,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        post.id, post.batchId, post.slot, post.category, post.topic, post.version,
        post.headline, post.caption, post.imagePath || null, json(post.sources), json(post.trend), post.status || 'pending_approval',
      );
      if (post.contentHash) db.prepare('UPDATE posts SET content_hash=? WHERE id=?').run(post.contentHash, post.id);
      addEvent.run(new Date().toISOString(), 'post_created', post.batchId, post.id, json({ version: post.version }));
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
    getPost(id) { const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id); return row ? { ...row, sources: parse(row.sources_json, []), trend: parse(row.trend_json, {}) } : null; },
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
