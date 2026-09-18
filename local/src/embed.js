// Embeddings, on the CPU, in this process.
//
// In this process and not in the browser, because a query arrives from Claude
// over MCP when the browser may be closed. The extension could embed at capture
// time on its GPU, but the query side has to stand alone, so the model lives
// here and capture-time acceleration is an optimisation for later.
//
// bge-small-en-v1.5: 384 dimensions, about 130MB once, a few hundred
// milliseconds for a page's worth of chunks. Small enough that CPU is not a
// compromise, which is what keeps `npx magpie-local` from needing a GPU.

import { EMBED_MODEL } from './config.js';
import { chunksNeedingVectors, putVector } from './db.js';

let loading = null;
let ready = false;

/**
 * The pipeline, loaded once and shared. Loading is deferred to the first
 * embedding rather than done at startup: the server answers keyword searches
 * and accepts captures while the model is still downloading, so a first run is
 * useful immediately instead of blocking on 130MB.
 */
export function pipe({ model = EMBED_MODEL } = {}) {
  loading ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // No remote code execution, no telemetry: this reads weights and nothing else.
    env.allowLocalModels = true;
    const extractor = await pipeline('feature-extraction', model, { dtype: 'fp32' });
    ready = true;
    return extractor;
  })().catch((err) => {
    // Forget the failure rather than memoising it: a model that would not load
    // because the machine was offline, or because the package was installed
    // without its dependencies, should be retried later rather than being
    // treated as permanently broken for the life of the process.
    loading = null;
    ready = false;
    throw err;
  });
  return loading;
}

/** Whether the model is loaded. False while 130MB is still arriving. */
export const isReady = () => ready;

/**
 * A vector, or null if the model is not loaded yet.
 *
 * This is what the search path uses, and the null is the point: the first run
 * downloads 130MB, and a search that waits for it is a search that hangs. A
 * keyword answer now beats a hybrid answer in four minutes, and the semantic
 * half starts appearing on its own once the download finishes.
 */
export async function embedIfReady(text, options = {}) {
  if (!ready) {
    // Start it, and swallow the failure *here*. Nobody is awaiting this
    // promise, and in Node an unhandled rejection takes the process down: a
    // model that will not load would kill the store on the first search
    // instead of costing that one search its semantic half.
    pipe(options).catch(() => {});
    return null;
  }
  return embed(text, options);
}

/** One vector for one string, mean-pooled and normalised so cosine is a dot product. */
export async function embed(text, options = {}) {
  const extractor = await pipe(options);
  const output = await extractor(String(text ?? ''), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/** Many at once. The model is batched internally; this keeps memory bounded. */
export async function embedAll(texts, options = {}) {
  const extractor = await pipe(options);
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    const result = await extractor(batch, { pooling: 'mean', normalize: true });
    const rows = result.tolist();
    for (const row of rows) out.push(row);
  }
  return out;
}

/**
 * Embeds what has no vector for the current model, a slice at a time.
 *
 * This is also the migration path. Changing the model leaves every old vector
 * in place but unreadable, because `chunksNeedingVectors` joins on the model
 * name: the rows come back as work to do, search ignores the stale ones, and
 * nobody has to run anything.
 */
export async function backfill(db, { limit = 64, model = EMBED_MODEL } = {}) {
  const pending = chunksNeedingVectors(db, { limit, model });
  if (!pending.length) return { embedded: 0, remaining: 0 };

  const vectors = await embedAll(pending.map((row) => row.text), { model });
  db.exec('BEGIN');
  try {
    pending.forEach((row, i) => putVector(db, row.id, vectors[i], model));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { embedded: pending.length, remaining: chunksNeedingVectors(db, { limit: 1, model }).length };
}

/**
 * Keeps backfilling until there is nothing left, then stops.
 *
 * Errors are swallowed on purpose: a machine with no network on the day the
 * model would first download must still capture and still search by keyword.
 * The work is in the database, so the next run picks it up.
 */
export function backfillLoop(db, { onProgress = () => {}, interval = 2000 } = {}) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      let result = { embedded: 0, remaining: 0 };
      try {
        result = await backfill(db);
      } catch (err) {
        onProgress({ error: String(err?.message ?? err) });
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      if (result.embedded) onProgress(result);
      await new Promise((r) => setTimeout(r, result.remaining ? 0 : interval));
    }
  })();
  return () => { stopped = true; };
}
