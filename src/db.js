import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function openDatabase(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(resolve(dataDir, 'vvc.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
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
  return db;
}

function json(value) { return JSON.stringify(value ?? null); }
function parse(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }

export function createStore(db) {
  const addEvent = db.prepare('INSERT INTO events(created_at,type,batch_id,post_id,payload_json) VALUES(?,?,?,?,?)');
  return {
    close() { db.close(); },
    createBatch({ id, createdAt = new Date().toISOString(), warning = null }) {
      db.prepare('INSERT INTO batches(id,created_at,status,warning) VALUES(?,?,?,?)').run(id, createdAt, 'draft', warning);
      addEvent.run(createdAt, 'batch_created', id, null, json({ warning }));
      return id;
    },
    insertPost(post) {
      db.prepare(`INSERT INTO posts
        (id,batch_id,slot,category,topic,version,headline,caption,image_path,sources_json,trend_json,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        post.id, post.batchId, post.slot, post.category, post.topic, post.version,
        post.headline, post.caption, post.imagePath || null, json(post.sources), json(post.trend), post.status || 'pending_approval',
      );
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
    approvePost(id) {
      const now = new Date().toISOString();
      const post = this.getPost(id);
      if (!post) return null;
      db.prepare("UPDATE posts SET status='approved', approved_at=?, last_error=NULL WHERE id=? AND status IN ('pending_approval','rejected')").run(now, id);
      addEvent.run(now, 'post_approved', post.batch_id, id, json({ version: post.version }));
      return this.getPost(id);
    },
    rejectPost(id, reason = 'Rejeitado pelo usuário') {
      const post = this.getPost(id); if (!post) return null;
      db.prepare("UPDATE posts SET status='rejected', last_error=? WHERE id=? AND status='pending_approval'").run(reason, id);
      addEvent.run(new Date().toISOString(), 'post_rejected', post.batch_id, id, json({ reason }));
      return this.getPost(id);
    },
    markScheduled(id, at) { db.prepare("UPDATE posts SET status='scheduled',scheduled_at=? WHERE id=? AND status='approved'").run(at, id); },
    markPublished(id, result) { db.prepare("UPDATE posts SET status='published',published_at=?,meta_photo_id=?,meta_post_id=?,last_error=NULL WHERE id=?").run(new Date().toISOString(), result.id, result.postId, id); },
    markUnknown(id, error) { db.prepare("UPDATE posts SET status='publication_unknown',last_error=? WHERE id=?").run(error, id); },
    listReady() { return db.prepare("SELECT id FROM posts WHERE status IN ('approved','scheduled') ORDER BY scheduled_at,slot").all().map(({ id }) => this.getPost(id)); },
    addEvent(type, { batchId = null, postId = null, ...payload } = {}) { addEvent.run(new Date().toISOString(), type, batchId, postId, json(payload)); },
  };
}
