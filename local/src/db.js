// The store: one SQLite file holding the pages, their chunks, the text index
// and the vectors.
//
// One file rather than a database plus a vector store, because hybrid search
// needs both halves and a join. Split them and every query becomes two round
// trips reconciled by hand in application code, which is where hybrid ranking
// goes wrong quietly.
//
// node:sqlite rather than better-sqlite3: it carries FTS5 with bm25() and
// snippet(), which is everything this needs, and it is built into Node, so the
// daemon has no native dependency and `npx magpie-local` works on any platform
// Node runs on. Verified before this was written; `allowExtension` is also
// supported, so sqlite-vec remains reachable if exact search ever stops being
// fast enough.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DB_PATH, EMBED_DIM, EMBED_MODEL, ensureHome } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id           TEXT PRIMARY KEY,
  space        TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  content      TEXT NOT NULL,
  source_kind  TEXT NOT NULL DEFAULT 'page',
  captured_at  TEXT NOT NULL,
  note         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_space_url ON pages (space, url);
CREATE INDEX IF NOT EXISTS pages_captured ON pages (captured_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_page ON chunks (page_id);

-- porter, so "compaction" finds a page that says "compact". Without a stemmer
-- an exact-word index reads as a broken search to anyone who does not already
-- know the word the author used.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize = 'porter unicode61');

CREATE TABLE IF NOT EXISTS vectors (
  chunk_id  INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_model ON vectors (model);
`;

export function open(path = DB_PATH) {
  if (path !== ':memory:') ensureHome();
  const fresh = path !== ':memory:' && !existsSync(path);

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  // The file holds the full text of everything you have read. It is not
  // encrypted, so its permissions are the protection, and they are set here
  // rather than left to the umask that happened to be in force.
  if (fresh) { try { chmodSync(path, 0o600); } catch { /* best effort */ } }
  return db;
}

/**
 * Stores a page and its chunks in one transaction.
 *
 * Re-capturing a page replaces it: the same URL in the same space is one
 * memory, not two. That is a deliberate difference from a cloud provider, where
 * a re-send is a second document; here the file is yours and a duplicate is
 * just noise in your own search results. The old chunks and vectors go with it,
 * so a page that changed does not leave the previous version's sentences behind
 * to be found later.
 */
export function upsertPage(db, page, chunks) {
  const id = page.id ?? randomUUID();
  const now = page.captured_at ?? new Date().toISOString();

  const tx = () => {
    const existing = db.prepare('SELECT id FROM pages WHERE space = ? AND url = ?').get(page.space, page.url);
    if (existing) deletePage(db, existing.id);

    db.prepare(`INSERT INTO pages (id, space, url, title, summary, content, source_kind, captured_at, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, page.space, page.url, page.title, page.summary ?? null, page.content,
           page.source_kind ?? 'page', now, page.note ?? null);

    const insertChunk = db.prepare('INSERT INTO chunks (page_id, ordinal, text) VALUES (?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)');
    const ids = [];
    chunks.forEach((text, ordinal) => {
      const { lastInsertRowid } = insertChunk.run(id, ordinal, text);
      insertFts.run(lastInsertRowid, text);
      ids.push(Number(lastInsertRowid));
    });
    return ids;
  };

  db.exec('BEGIN');
  try {
    const ids = tx();
    db.exec('COMMIT');
    return { id, chunkIds: ids, replaced: true };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Removes a page and everything derived from it, including its text index. */
export function deletePage(db, pageId) {
  const rows = db.prepare('SELECT id FROM chunks WHERE page_id = ?').all(pageId);
  const dropFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
  for (const row of rows) dropFts.run(row.id);
  db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
}

export const getPage = (db, id) => db.prepare('SELECT * FROM pages WHERE id = ?').get(id) ?? null;

export const getPageByUrl = (db, space, url) =>
  db.prepare('SELECT * FROM pages WHERE space = ? AND url = ?').get(space, url) ?? null;

export function recentPages(db, { limit = 20, space = null } = {}) {
  return space
    ? db.prepare('SELECT * FROM pages WHERE space = ? ORDER BY captured_at DESC LIMIT ?').all(space, limit)
    : db.prepare('SELECT * FROM pages ORDER BY captured_at DESC LIMIT ?').all(limit);
}

/** The spaces that exist, which is simply the ones that have been written to. */
export function spaces(db) {
  return db.prepare(`SELECT space AS space_id, COUNT(*) AS pages
                     FROM pages GROUP BY space ORDER BY space`).all();
}

export function stats(db) {
  const pages = db.prepare('SELECT COUNT(*) AS n FROM pages').get().n;
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  const vectors = db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE model = ?').get(EMBED_MODEL).n;
  return { pages, chunks, vectors, model: EMBED_MODEL, dim: EMBED_DIM };
}

// ------------------------------------------------------------------ vectors --

export const toBlob = (vector) => Buffer.from(new Float32Array(vector).buffer);
export const fromBlob = (blob) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

export function putVector(db, chunkId, vector, model = EMBED_MODEL) {
  db.prepare(`INSERT INTO vectors (chunk_id, model, dim, embedding) VALUES (?, ?, ?, ?)
              ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, dim = excluded.dim,
                                                  embedding = excluded.embedding`)
    .run(chunkId, model, vector.length, toBlob(vector));
}

/**
 * Chunks with no vector for the *current* model.
 *
 * Model and dimension are stored per row on purpose. Changing the embedding
 * model invalidates every vector, and comparing across models does not fail, it
 * returns plausible nonsense. So a row from another model is not read; it is
 * re-embedded in the background and ignored by search until it has been.
 */
export function chunksNeedingVectors(db, { limit = 256, model = EMBED_MODEL } = {}) {
  return db.prepare(`SELECT c.id, c.text FROM chunks c
                     LEFT JOIN vectors v ON v.chunk_id = c.id AND v.model = ?
                     WHERE v.chunk_id IS NULL
                     ORDER BY c.id DESC LIMIT ?`).all(model, limit);
}

/** Every vector for the current model, for an exact scan. */
export function allVectors(db, { space = null, model = EMBED_MODEL } = {}) {
  const sql = space
    ? `SELECT v.chunk_id, v.embedding FROM vectors v
       JOIN chunks c ON c.id = v.chunk_id JOIN pages p ON p.id = c.page_id
       WHERE v.model = ? AND p.space = ?`
    : 'SELECT chunk_id, embedding FROM vectors WHERE model = ?';
  const rows = space ? db.prepare(sql).all(model, space) : db.prepare(sql).all(model);
  return rows.map((row) => ({ chunkId: row.chunk_id, vector: fromBlob(row.embedding) }));
}

/** The rows a result list points at, with their page, in one query. */
export function hydrate(db, chunkIds) {
  if (!chunkIds.length) return new Map();
  const marks = chunkIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT c.id AS chunk_id, c.text, c.ordinal,
                                  p.id AS page_id, p.title, p.url, p.space, p.captured_at,
                                  p.summary, p.source_kind
                           FROM chunks c JOIN pages p ON p.id = c.page_id
                           WHERE c.id IN (${marks})`).all(...chunkIds);
  return new Map(rows.map((row) => [row.chunk_id, row]));
}
