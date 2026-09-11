// The engine. Owns the WebLLM instance, the map-reduce, and — for distill mode —
// the provider write.
//
// The write happens here rather than in the service worker because the worker is
// very likely dead by the time a distill finishes (verified in spikes/phase0).
// This is an extension page, so it is exempt from CORS for hosts granted in
// host_permissions, exactly as the worker is.

import { CreateMLCEngine } from '@mlc-ai/web-llm';
import { MSG, TO_OFFSCREEN, respondAsync } from './lib/messages.js';
import { planSummarisation, reducePlan, estimateTokens } from './lib/chunk.js';
import { push } from './lib/providers/registry.js';
import { appConfigFor } from './lib/models.js';

const jobs = new Map();        // tabId -> job state, the record the popup reads

// The engine is addressed as a promise, never as "a variable that will be set
// soon". Two captures started close together used to race: the second awaited
// the first's load, resumed before the first had assigned its result, saw no
// engine, and started a second full load. That produced two engines fighting
// over one GPU device — the first one's handle then answering
// "Model not loaded before trying to complete ChatCompletionRequest" — and it
// paid the multi-minute load twice.
let enginePromise = null;
let engineModelId = null;
let engine = null;             // resolved value, for status reporting only

// Load progress belongs to whoever is waiting, and several jobs may be.
const progressListeners = new Set();

// ---------------------------------------------------------------- engine ----

/**
 * A one-model appConfig whose model_lib points at the copy inside the extension.
 * Chrome treats a .wasm fetched from a CDN as remotely-hosted code, which is a
 * flat Web Store rejection; weights are data and stay remote.
 */
function localAppConfig(model) {
  return appConfigFor(model, chrome.runtime.getURL(`wasm/${model.libFile}`));
}

function getEngine(model) {
  // Already loaded, or already loading, for this exact model: share it.
  if (enginePromise && engineModelId === model.id) return enginePromise;

  const previous = enginePromise;
  engineModelId = model.id;

  enginePromise = (async () => {
    // A model switch tears the old engine down first — two resident models will
    // not fit in the video memory the small one was chosen to respect.
    if (previous) {
      const old = await previous.catch(() => null);
      await old?.unload?.().catch(() => {});
      engine = null;
    }

    if (!navigator.gpu) {
      const err = new Error('This browser or GPU does not support WebGPU.');
      err.code = 'webgpu_unavailable';
      throw err;
    }

    // Roughly 1.1-1.8 GB of weights land in the cache. Without this they are
    // evictable, and eviction looks like a download that never sticks.
    navigator.storage?.persist?.().catch(() => {});

    engine = await CreateMLCEngine(model.id, {
      appConfig: localAppConfig(model),
      initProgressCallback: (p) => { for (const fn of progressListeners) { try { fn(p); } catch { /* a dead listener must not stop a load */ } } },
    });
    return engine;
  })();

  // A rejected promise must not be cached, or one failed load makes every later
  // capture fail instantly with a stale error and no way to retry.
  enginePromise.catch(() => {
    if (engineModelId === model.id) { enginePromise = null; engineModelId = null; engine = null; }
  });

  return enginePromise;
}

// ------------------------------------------------------------- prompting ----
const SYSTEM = 'You summarise web pages. Be factual and concise. Never invent details that are not in the text. Reply with the summary only, no preamble.';

const prompts = {
  whole: (title, text) =>
    `Summarise this article in 3-5 sentences. Keep specific names, numbers and conclusions.\n\nTitle: ${title}\n\n${text}`,
  section: (title, text, i, n) =>
    `This is section ${i} of ${n} of a longer article. Summarise just this section in 2-3 sentences, keeping specific names, numbers and claims.\n\nTitle: ${title}\n\n${text}`,
  reduce: (title, text) =>
    `These are section summaries of one article, in order. Write a single 4-6 sentence summary of the whole article. Do not refer to "sections" or to the summarising process.\n\nTitle: ${title}\n\n${text}`,
};

// One engine, one GPU, one completion at a time. Overlapping requests on a
// single WebLLM engine interleave on the same KV cache, so they are queued
// rather than issued concurrently — two captures at once are otherwise a way to
// get two wrong summaries instead of one right one.
let inferenceQueue = Promise.resolve();

function complete(engineRef, prompt) {
  const run = inferenceQueue.then(() => rawComplete(engineRef, prompt));
  // The queue tracks ordering, not outcomes: one failure must not poison every
  // request behind it.
  inferenceQueue = run.then(() => {}, () => {});
  return run;
}

async function rawComplete(engineRef, prompt) {
  const res = await engineRef.chat.completions.create({
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 350,
  });
  return (res.choices?.[0]?.message?.content ?? '').trim();
}

// ------------------------------------------------------------------ jobs ----
const RUNNING = new Set(['starting', 'loading', 'summarising', 'writing']);
let lastBroadcast = 0;

function update(job, patch) {
  const previousState = job.state;
  Object.assign(job, patch);
  jobs.set(job.tabId, job);

  // WebLLM reports load progress many times a second and every broadcast wakes
  // the service worker, so the stream is throttled — but a state change or a
  // finished job is never delayed, because those are what the badge reacts to.
  const now = Date.now();
  const notable = job.state !== previousState || !RUNNING.has(job.state);
  if (!notable && now - lastBroadcast < 250) return job;
  lastBroadcast = now;

  // Best-effort: nobody may be listening, and that is the normal case for the
  // keyboard-shortcut path.
  chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job }).catch(() => {});
  return job;
}

/**
 * WebLLM's own progress text is a paragraph — "Fetching param cache[9/30]:
 * 227MB fetched. 27% completed, 68 secs elapsed. It can take a while when we
 * first visit this page…". True, and far too long for a 360px panel, so the
 * phase is named here and the numbers ride the progress bar instead.
 */
function describeLoad(report) {
  const text = report?.text ?? '';
  const megabytes = text.match(/(\d+(?:\.\d+)?)\s*MB/i)?.[1];

  if (/fetch|param cache/i.test(text)) {
    return megabytes ? `Downloading the model · ${megabytes} MB` : 'Downloading the model';
  }
  if (/cache|loading/i.test(text)) return 'Loading the model';
  if (/webgpu|finish/i.test(text)) return 'Starting the model';
  return 'Loading the model';
}

async function runDistill({ job: incoming, model, providerConfig }) {
  // Pressing the shortcut twice, or the button while the model is still
  // downloading, must attach to the capture already running for this tab rather
  // than start a second one against the same engine.
  const running = jobs.get(incoming.tabId);
  if (running && RUNNING.has(running.state)) return running;

  const job = {
    ...incoming,
    state: 'starting',
    step: 0,
    totalSteps: 0,
    stage: 'Reading the page',
    result: null,
    stored: null,
  };
  jobs.set(job.tabId, job);

  try {
    const plan = planSummarisation(incoming.text, model.contextWindow);
    update(job, { totalSteps: plan.totalCalls, stage: 'Loading the model' });

    // WebLLM reports download and GPU-upload progress as one 0..1 figure.
    const onProgress = (report) =>
      update(job, { state: 'loading', stage: describeLoad(report), loadProgress: report.progress ?? 0 });

    progressListeners.add(onProgress);
    let engineRef;
    try {
      engineRef = await getEngine(model);
    } finally {
      progressListeners.delete(onProgress);
    }

    update(job, { state: 'summarising', loadProgress: 1 });

    let summary;
    if (plan.chunks.length === 1) {
      update(job, { stage: 'Summarising', step: 1 });
      summary = await complete(engineRef, prompts.whole(job.title, plan.chunks[0]));
    } else {
      const parts = [];
      for (const [i, chunk] of plan.chunks.entries()) {
        update(job, { stage: `Summarising part ${i + 1} of ${plan.chunks.length}`, step: i + 1 });
        parts.push(await complete(engineRef, prompts.section(job.title, chunk, i + 1, plan.chunks.length)));
      }

      // Reduce. If the joined section summaries still overflow, fold them in
      // groups until they fit rather than silently truncating.
      let pending = parts;
      let round = reducePlan(pending, plan.budgetTokens);
      while (!round.fits) {
        update(job, { stage: 'Condensing' });
        const folded = [];
        for (const group of round.chunks) folded.push(await complete(engineRef, prompts.reduce(job.title, group)));
        pending = folded;
        round = reducePlan(pending, plan.budgetTokens);
      }

      update(job, { stage: 'Writing the summary', step: plan.totalCalls });
      summary = await complete(engineRef, prompts.reduce(job.title, round.joined));
    }

    if (!summary) throw new Error('The model returned an empty summary.');

    update(job, { state: 'writing', stage: `Saving to ${job.providerId}`, summary });

    const result = await push(job.providerId, {
      title: job.title, url: job.url, content: summary, capturedAt: job.capturedAt, mode: 'distill',
    }, providerConfig);

    return update(job, {
      state: result.ok ? 'remembered' : 'error',
      stage: result.ok ? 'Remembered' : 'Could not save',
      result,
      stored: { chars: summary.length, tokens: estimateTokens(summary), kind: 'summary' },
    });
  } catch (err) {
    return update(job, { state: 'error', stage: 'Failed', result: { ok: false, ...classify(err) } });
  }
}

/** Turn an engine failure into something with a recovery action attached. */
function classify(err) {
  const message = String(err?.message ?? err);
  if (err?.code === 'webgpu_unavailable' || /webgpu/i.test(message)) {
    return {
      code: 'webgpu_unavailable',
      message: 'This browser or GPU cannot run a local model.',
      recover: 'raw',
    };
  }
  if (/out of memory|device lost|allocation|oom/i.test(message)) {
    return {
      code: 'out_of_memory',
      message: 'The GPU ran out of memory loading the model.',
      recover: 'smaller_model',
    };
  }
  if (/fetch|network|failed to load|cache/i.test(message)) {
    return { code: 'model_download_failed', message: `Could not download the model. ${message}`, recover: 'retry' };
  }
  return { code: 'engine_failed', message };
}

// ---------------------------------------------------------------- wiring ----
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== TO_OFFSCREEN) return false;

  switch (msg.type) {
    case MSG.RUN_DISTILL:
      // Deliberately not awaited: the reply goes back now with the initial job
      // state, and the work continues here after the caller (and the service
      // worker) have gone away.
      runDistill(msg);
      return respondAsync(async () => jobs.get(msg.job.tabId) ?? { tabId: msg.job.tabId, state: 'starting' }, respond);
    case MSG.GET_JOB:
      return respondAsync(async () => jobs.get(msg.tabId) ?? null, respond);
    case MSG.PRELOAD_MODEL:
      return respondAsync(async () => {
        await getEngine(msg.model);
        return { ok: true, modelId: engineModelId };
      }, respond);
    case MSG.ENGINE_STATUS:
      return respondAsync(async () => ({ loaded: Boolean(engine), modelId: engineModelId, webgpu: Boolean(navigator.gpu) }), respond);
    default:
      return false;
  }
});
