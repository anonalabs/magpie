// The lifecycle of the one local model: loading it, sharing it, throwing it away
// when the GPU faults, and making sure requests never straddle a rebuild.
//
// Extracted from the offscreen document and given an injected `create` so it can
// be tested. It has produced the same class of bug twice, a handle used after
// the engine behind it was gone, and neither time was catchable where it lived,
// because the code sat behind WebGPU that no test machine here has.
//
// Three rules, each earned:
//
//   1. The engine is addressed as a promise, never as "a variable that will be
//      set soon". Two captures starting together raced: the second saw no engine
//      yet and started a second full load.
//   2. Tearing down and building up are serialised. WebLLM's unload releases
//      state the replacement is claiming, so running them at once can unload the
//      model that just loaded, reported as "Model not loaded" on an engine that
//      had in fact just loaded.
//   3. A queued request resolves the engine when it runs, never when it is
//      queued. Otherwise one job discarding a faulted engine leaves everything
//      behind it in the queue holding a handle to a model that no longer exists.

export function createEnginePool({ create }) {
  let promise = null;      // Promise<engine> for `modelId`
  let modelId = null;
  let current = null;      // the resolved engine, for status only
  let teardown = Promise.resolve();
  let queue = Promise.resolve();

  const listeners = new Set();
  const report = (progress) => {
    for (const listener of listeners) {
      try { listener(progress); } catch { /* a dead listener must not stop a load */ }
    }
  };

  function get(model) {
    if (promise && modelId === model.id) return promise;

    const previous = promise;
    modelId = model.id;

    promise = (async () => {
      await teardown;

      // A model switch tears the old one down first: two resident models will
      // not fit in the memory the smaller one was chosen to respect.
      if (previous) {
        const old = await previous.catch(() => null);
        await old?.unload?.().catch(() => {});
        current = null;
      }

      current = await create(model, { onProgress: report });
      return current;
    })();

    // A rejected load must not be cached, or one failure makes every later
    // attempt fail instantly with a stale error and no way to retry.
    promise.catch(() => {
      if (modelId === model.id) { promise = null; modelId = null; current = null; }
    });

    return promise;
  }

  function discard() {
    const dying = promise;
    promise = null;
    modelId = null;
    current = null;
    teardown = dying
      ? dying.then((old) => old?.unload?.().catch(() => {}), () => {})
      : Promise.resolve();
    return teardown;
  }

  /** One model, one GPU, one request at a time, and always the current engine. */
  function run(model, fn) {
    const task = queue.then(async () => fn(await get(model)));
    // The queue tracks ordering, not outcomes: one failure must not poison
    // everything behind it.
    queue = task.then(() => {}, () => {});
    return task;
  }

  return {
    get,
    run,
    discard,
    listeners,
    status: () => ({ loaded: Boolean(current), modelId }),
  };
}
