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
let engine = null;
let engineModelId = null;
let engineLoading = null;

// ---------------------------------------------------------------- engine ----

/**
 * A one-model appConfig whose model_lib points at the copy inside the extension.
 * Chrome treats a .wasm fetched from a CDN as remotely-hosted code, which is a
 * flat Web Store rejection; weights are data and stay remote.
 */
function localAppConfig(model) {
  return appConfigFor(model, chrome.runtime.getURL(`wasm/${model.libFile}`));
}

async function getEngine(model, onProgress) {
  if (engine && engineModelId === model.id) return engine;
  if (engineLoading) await engineLoading.catch(() => {});
  if (engine && engineModelId === model.id) return engine;

  if (!navigator.gpu) {
    const err = new Error('This browser or GPU does not support WebGPU.');
    err.code = 'webgpu_unavailable';
    throw err;
  }

  if (engine) { await engine.unload().catch(() => {}); engine = null; engineModelId = null; }

  // Roughly 1.1-1.8 GB of weights land in the cache. Without this they are
  // evictable, and eviction looks to the user like a download that never sticks.
  navigator.storage?.persist?.().catch(() => {});

  engineLoading = CreateMLCEngine(model.id, {
    appConfig: localAppConfig(model),
    initProgressCallback: (p) => onProgress?.(p),
  });

  try {
    engine = await engineLoading;
    engineModelId = model.id;
    return engine;
  } finally {
    engineLoading = null;
  }
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

async function complete(engineRef, prompt) {
  const res = await engineRef.chat.completions.create({
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 350,
  });
  return (res.choices?.[0]?.message?.content ?? '').trim();
}

// ------------------------------------------------------------------ jobs ----
function update(job, patch) {
  Object.assign(job, patch);
  jobs.set(job.tabId, job);
  // Best-effort: nobody may be listening, and that is the normal case for the
  // keyboard-shortcut path.
  chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job }).catch(() => {});
  return job;
}

async function runDistill({ job: incoming, model, providerConfig }) {
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

    const engineRef = await getEngine(model, (p) => {
      // WebLLM reports download and GPU-upload progress as one 0..1 figure.
      update(job, { state: 'loading', stage: p.text || 'Loading the model', loadProgress: p.progress ?? 0 });
    });

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
        await getEngine(msg.model, () => {});
        return { ok: true, modelId: engineModelId };
      }, respond);
    case MSG.ENGINE_STATUS:
      return respondAsync(async () => ({ loaded: Boolean(engine), modelId: engineModelId, webgpu: Boolean(navigator.gpu) }), respond);
    default:
      return false;
  }
});
