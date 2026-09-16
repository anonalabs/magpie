// Everything the store knows about itself.
//
// Read from your own file, printed on your own terminal, and sent nowhere. This
// is the opposite of telemetry: magpie has none, and the reason this exists is
// that a store you cannot see into is one you cannot trust.

import { statSync } from 'node:fs';
import { EMBED_MODEL } from './config.js';

const safeSize = (path) => { try { return statSync(path).size; } catch { return 0; } };

/** The last `days` days of capture, oldest first, with no gaps. */
export function byDay(db, days = 14) {
  const rows = db.prepare(`SELECT substr(captured_at, 1, 10) AS day, COUNT(*) AS n
                           FROM pages GROUP BY day`).all();
  const counts = new Map(rows.map((r) => [r.day, r.n]));

  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: date, n: counts.get(date) ?? 0 });
  }
  return out;
}

export function report(db, { dbPath } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const pages = one('SELECT COUNT(*) AS n FROM pages').n;
  const chunks = one('SELECT COUNT(*) AS n FROM chunks').n;
  const vectors = one('SELECT COUNT(*) AS n FROM vectors WHERE model = ?', EMBED_MODEL).n;
  const stale = one('SELECT COUNT(*) AS n FROM vectors WHERE model != ?', EMBED_MODEL).n;
  const characters = one('SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM pages').n;
  const withSummary = one('SELECT COUNT(*) AS n FROM pages WHERE summary IS NOT NULL').n;

  return {
    pages,
    chunks,
    vectors,
    staleVectors: stale,
    characters,
    withSummary,
    words: Math.round(characters / 5.6),
    newest: one('SELECT captured_at, title, url FROM pages ORDER BY captured_at DESC LIMIT 1') ?? null,
    oldest: one('SELECT captured_at FROM pages ORDER BY captured_at ASC LIMIT 1')?.captured_at ?? null,
    spaces: db.prepare(`SELECT space, COUNT(*) AS pages FROM pages
                        GROUP BY space ORDER BY pages DESC, space`).all(),
    kinds: db.prepare(`SELECT source_kind AS kind, COUNT(*) AS pages FROM pages
                       GROUP BY kind ORDER BY pages DESC`).all(),
    days: byDay(db),
    model: EMBED_MODEL,
    // Both files, because the write-ahead log is part of how big this is on disk
    // and leaving it out makes the number quietly wrong.
    diskBytes: dbPath ? safeSize(dbPath) + safeSize(`${dbPath}-wal`) : 0,
  };
}
