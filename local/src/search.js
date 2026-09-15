// Finding things again.
//
// Two retrievers over the same file: FTS5 for the words that were actually
// written, and an exact vector scan for the ones that were not. Their orders
// are fused with Reciprocal Rank Fusion, which needs no weight to tune and no
// score calibration between two things that do not measure the same quantity.
//
// What is deliberately absent: a cross-encoder reranker, and any generation.
// The reranker is the expensive stage and the one whose tuning is the product;
// generation belongs to the caller, which in an MCP setup is already a model.

import { allVectors, hydrate } from './db.js';

/** FTS5 reads its input as a query language. A reader's words are not one. */
export function ftsQuery(text) {
  const tokens = String(text ?? '')
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((t) => t.length > 1) ?? [];
  // Each token quoted, so AND / OR / NEAR / * / - in a reader's question are
  // matched as words instead of changing what the query means. Joined with OR,
  // not FTS5's implicit AND: a search box where every word must appear returns
  // nothing for the way people actually type, and bm25 already ranks a chunk
  // carrying more of the words above one carrying fewer.
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export function ftsSearch(db, text, { limit = 50, space = null } = {}) {
  const query = ftsQuery(text);
  if (!query) return [];

  const sql = space
    ? `SELECT f.rowid AS chunk_id, bm25(chunks_fts) AS score,
              snippet(chunks_fts, 0, '[', ']', '…', 14) AS snippet
       FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN pages p ON p.id = c.page_id
       WHERE chunks_fts MATCH ? AND p.space = ? ORDER BY score LIMIT ?`
    : `SELECT rowid AS chunk_id, bm25(chunks_fts) AS score,
              snippet(chunks_fts, 0, '[', ']', '…', 14) AS snippet
       FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`;

  const rows = space ? db.prepare(sql).all(query, space, limit) : db.prepare(sql).all(query, limit);
  // bm25() is negative and ascending-better. Rank is what the fusion uses, so
  // the sign never has to be reasoned about again.
  return rows.map((row, i) => ({ chunkId: row.chunk_id, rank: i + 1, snippet: row.snippet, score: row.score }));
}

/** Cosine over stored vectors. They are normalised on the way in, so this is a dot product. */
export function vectorSearch(db, queryVector, { limit = 50, space = null } = {}) {
  if (!queryVector?.length) return [];
  const rows = allVectors(db, { space });
  if (!rows.length) return [];

  const scored = rows.map(({ chunkId, vector }) => {
    let dot = 0;
    for (let i = 0; i < vector.length && i < queryVector.length; i++) dot += vector[i] * queryVector[i];
    return { chunkId, score: dot };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * Reciprocal Rank Fusion. `k` damps the top of each list so one retriever
 * cannot win on rank 1 alone; 60 is the value from the paper and there is no
 * reason to tune it here.
 */
export function rrf(lists, { k = 60 } = {}) {
  const totals = new Map();
  for (const list of lists) {
    for (const item of list) {
      const current = totals.get(item.chunkId) ?? { chunkId: item.chunkId, score: 0, snippet: null, from: [] };
      current.score += 1 / (k + item.rank);
      current.snippet ??= item.snippet ?? null;
      if (item.snippet && !current.snippet) current.snippet = item.snippet;
      current.from.push(item.source ?? 'unknown');
      totals.set(item.chunkId, current);
    }
  }
  return [...totals.values()].sort((a, b) =>
    b.score - a.score || a.chunkId - b.chunkId);
}

const label = (list, source) => list.map((row) => ({ ...row, source }));

/**
 * One search. `embed` is injected rather than imported so this file stays
 * testable without a model: hand it a function, or nothing at all for
 * keyword-only results.
 */
export async function search(db, text, { k = 8, space = null, embed = null } = {}) {
  const keyword = label(ftsSearch(db, text, { space }), 'keyword');

  let semantic = [];
  if (embed) {
    try {
      // null means the model is not loaded yet. Keyword results stand on their
      // own; the semantic half joins in later without anybody being told to
      // wait for it.
      const vector = await embed(text);
      if (vector) semantic = label(vectorSearch(db, vector, { space }), 'semantic');
    } catch {
      // A model that will not load must cost the semantic half of one search,
      // never the search itself. Keyword results are a complete answer.
      semantic = [];
    }
  }

  const fused = rrf([keyword, semantic]).slice(0, k);
  const rows = hydrate(db, fused.map((row) => row.chunkId));

  return fused.map((row) => {
    const chunk = rows.get(row.chunkId);
    if (!chunk) return null;
    return {
      page_id: chunk.page_id,
      title: chunk.title,
      url: chunk.url,
      space: chunk.space,
      captured_at: chunk.captured_at,
      source_kind: chunk.source_kind,
      ordinal: chunk.ordinal,
      text: chunk.text,
      snippet: row.snippet ?? chunk.text.slice(0, 220),
      matched: [...new Set(row.from)],
      score: Number(row.score.toFixed(6)),
    };
  }).filter(Boolean);
}
