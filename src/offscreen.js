// The engine. Owns the WebLLM instance, the map-reduce, and, for distill mode,
// the provider write.
//
// The write happens here rather than in the service worker because the worker is
// very likely dead by the time a distill finishes (verified in spikes/phase0).
// This is an extension page, so it is exempt from CORS for hosts granted in
// host_permissions, exactly as the worker is.

import { CreateMLCEngine } from '@mlc-ai/web-llm';
import { MSG, TO_OFFSCREEN, respondAsync, toBackground } from './lib/messages.js';
import { planSummarisation, reducePlan, splitInHalf, estimateTokens } from './lib/chunk.js';
import { appConfigFor, MODELS, smallerThan } from './lib/models.js';

/** Which entry in MODELS this is, so a recovery can step down from it. */
const sizeOf = (model) => Object.keys(MODELS).find((size) => MODELS[size].id === model?.id) ?? null;
import { isDeviceLost, isGpuFault } from './lib/gpu.js';
import { createEnginePool } from './lib/engine-pool.js';
// The legacy build, deliberately. The modern one calls
// Uint8Array.prototype.toHex without defining it, a very recent method that
// Chrome did not have until long after this extension's floor of 116, so the
// modern build fails on any browser magpie claims to support. Only the legacy
// build ships the polyfill.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfBody, MAX_PAGES } from './lib/pdf-text.js';

// A file, not a data: URI. MV3's CSP refuses the latter.
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js');

const jobs = new Map();        // tabId -> job state, the record the popup reads

/**
 * A one-model appConfig whose model_lib points at the copy inside the extension.
 * Chrome treats a .wasm fetched from a CDN as remotely-hosted code, which is a
 * flat Web Store rejection; weights are data and stay remote.
 */
function localAppConfig(model) {
  return appConfigFor(model, chrome.runtime.getURL(`wasm/${model.libFile}`));
}

// Loading, sharing, discarding and queueing all live in engine-pool.js, where
// they can be tested. They produced the same class of bug twice here, a handle
// used after the engine behind it was gone, and neither time was catchable in
// this file, because it only runs behind WebGPU.
const pool = createEnginePool({
  create: async (model, { onProgress }) => {
    if (!navigator.gpu) {
      const err = new Error('This browser or GPU does not support WebGPU.');
      err.code = 'webgpu_unavailable';
      throw err;
    }

    // Roughly 1.1-1.8 GB of weights land in the cache. Without this they are
    // evictable, and eviction looks like a download that never sticks.
    navigator.storage?.persist?.().catch(() => {});

    return CreateMLCEngine(model.id, {
      appConfig: localAppConfig(model),
      initProgressCallback: onProgress,
    });
  },
});

// Load progress belongs to whoever is waiting, and several jobs may be.
const progressListeners = pool.listeners;
// Every path to the engine goes through here, so the request not to evict the
// weights is made before the first byte of them is written, not after.
const getEngine = async (model) => { persistStorage(); return pool.get(model); };
const discardEngine = () => pool.discard();

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

/**
 * Asks the browser to stop treating 1.6GB of model weights as disposable.
 *
 * Without this the weights live in best-effort storage, which Chrome evicts
 * under pressure, and a large cache is exactly what it reaches for first. The
 * symptom is the model downloading again on a page it had already loaded for,
 * which reads as "it never caches anything" and is the difference between a
 * capture taking seconds and taking minutes.
 *
 * Asked once, and never awaited by anything on the capture path: a refusal is
 * worth knowing about and is not a reason to fail to summarise. Chrome grants
 * it to installed extensions without a prompt.
 */
let persisted = null;
async function persistStorage() {
  if (persisted !== null) return persisted;
  try {
    persisted = await navigator.storage.persisted() || await navigator.storage.persist();
  } catch {
    persisted = false;
  }
  return persisted;
}

/** How much the weights are actually taking, for somebody who wants to know. */
async function storageEstimate() {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

// One engine, one GPU, one request at a time, and always the engine that
// exists when the request runs, never the one that existed when it was queued.
const complete = (model, prompt) => pool.run(model, (engine) => rawComplete(engine, prompt));

async function rawComplete(engineRef, prompt) {
  const res = await engineRef.chat.completions.create({
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 350,
  });
  return (res.choices?.[0]?.message?.content ?? '').trim();
}

// ------------------------------------------------------------------- pdf ----
/**
 * Reads a PDF that Chrome is displaying in its own viewer.
 *
 * Content scripts cannot be injected into that viewer, so the file is fetched
 * and parsed here rather than read off the page. This document has a DOM, which
 * pdf.js needs, and already owns long-running work.
 */
async function extractPdf(url) {
  let bytes;
  try {
    // Credentials included: a paper behind a session cookie is a normal case,
    // and without them it comes back as a login page rather than a paper.
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    const local = url.startsWith('file://');
    const error = new Error(local
      ? 'Chrome blocks extensions from reading local files until you allow it: '
        + 'open chrome://extensions, click Details on magpie, and turn on "Allow access to file URLs".'
      : `Could not download this PDF. ${err.message ?? err}`);
    error.code = local ? 'pdf_file_access' : 'pdf_fetch_failed';
    throw error;
  }

  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false }).promise;
  } catch (err) {
    const error = new Error(/password/i.test(String(err?.message))
      ? 'This PDF is password-protected, so magpie cannot read it.'
      : `Could not open this PDF. ${err?.message ?? err}`);
    error.code = 'pdf_unreadable';
    throw error;
  }

  const pages = [];
  for (let number = 1; number <= Math.min(doc.numPages, MAX_PAGES); number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    // hasEOL marks a line end; without it every page is one unbroken run and
    // the chunker has no boundary finer than the page to cut on.
    pages.push(content.items.map((item) => (item.hasEOL ? `${item.str}\n` : item.str)).join(' ').trim());
  }

  const body = pdfBody(pages, doc.numPages);
  if (!body.text.replace(/\(Summarised from[^)]*\)/, '').trim()) {
    const error = new Error('This PDF has no text in it. It looks scanned. Reading that needs OCR, which magpie does not do.');
    error.code = 'pdf_no_text';
    throw error;
  }
  return body;
}

async function runPdf({ job: incoming, model }) {
  const running = jobs.get(incoming.tabId);
  if (running && RUNNING.has(running.state)) return running;

  const job = { ...incoming, state: 'starting', stage: 'Reading the PDF', step: 0, totalSteps: 0, result: null };
  jobs.set(job.tabId, job);
  update(job, {});

  let body;
  try {
    body = await extractPdf(incoming.url);
  } catch (err) {
    return update(job, {
      state: 'error', stage: 'Failed',
      result: { ok: false, code: err.code ?? 'pdf_failed', message: err.message },
    });
  }

  const pdfMeta = { pagesRead: body.pagesRead, pagesTotal: body.pagesTotal };

  // Raw mode has nothing to distil: the text goes as it is.
  if (incoming.mode === 'raw') {
    update(job, { state: 'writing', stage: 'Saving' });
    const settled = await handOff({
      ...incoming, content: body.text, chars: body.text.length, kind: 'PDF text', ...pdfMeta,
    });
    return update(job, settled);
  }

  return runDistill({ job: { ...job, text: body.text, ...pdfMeta }, model });
}

// ------------------------------------------------------------------ jobs ----
const RUNNING = new Set(['starting', 'loading', 'summarising', 'writing']);
let lastBroadcast = 0;

function update(job, patch) {
  const previousState = job.state;
  Object.assign(job, patch);
  jobs.set(job.tabId, job);

  // WebLLM reports load progress many times a second and every broadcast wakes
  // the service worker, so the stream is throttled, but a state change or a
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
 * WebLLM's own progress text is a paragraph: "Fetching param cache[9/30]:
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

/**
 * Hands a finished summary to the service worker, which owns the queue.
 *
 * This document cannot reach chrome.storage, so the message is the only route to
 * disk, and it is also what wakes a worker that has long since been killed. It
 * is retried rather than attempted once: dropping it would throw away the whole
 * point of the capture at the very last step.
 */
async function handOff(record, attempts = 4) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const settled = await toBackground(MSG.ENQUEUE, { record });
      if (settled) return settled;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw new Error(`Could not save the summary. ${last?.message ?? 'The extension did not respond.'}`);
}

async function runDistill({ job: incoming, model, draft = false }) {
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

  // Registered for the whole job, not just the first load: if the GPU device is
  // lost mid-job the model is reloaded, and that reload needs to report progress
  // too or the popup sits on a stale "part 3 of 6" for a minute.
  const onProgress = (report) =>
    update(job, { state: 'loading', stage: describeLoad(report), loadProgress: report.progress ?? 0 });
  progressListeners.add(onProgress);

  try {
    const plan = planSummarisation(incoming.text, model.contextWindow);
    update(job, { totalSteps: plan.totalCalls, stage: 'Loading the model' });

    // Every model call goes through here. The engine is resolved per call rather
    // than held for the whole job, so a discarded engine is simply reloaded on
    // the next one.
    const ask = async (prompt, stage, step) => {
      for (let attempt = 0; ; attempt++) {
        // Waited on here so the load reports progress; the call itself resolves
        // the engine again inside the queue, which is the one that counts.
        await getEngine(model);
        update(job, { state: 'summarising', loadProgress: 1, stage, ...(step ? { step } : {}) });
        try {
          return await complete(model, prompt);
        } catch (err) {
          // Any GPU-level fault leaves the engine suspect, and it is cached,
          // so without this, one fault breaks every capture until the extension
          // is reloaded. Discard it and rebuild once. The weights are already
          // cached, so this costs seconds rather than another download.
          if (!isGpuFault(err) || attempt > 0) throw err;
          discardEngine();
          update(job, { state: 'loading', loadProgress: 0, stage: 'The GPU stumbled, reloading the model' });
        }
      }
    };

    /**
     * An empty answer almost always means the prompt overran the model's context
     * window: the token count is an estimate, and a page dense with URLs or code
     * costs far more than its length suggests. Halving the input and trying
     * again is what stops that estimate being load-bearing: it is cheaper to
     * spend an extra call than to lose the capture.
     */
    const summarise = async (text, build, stage, step, depth = 0) => {
      const answer = await ask(build(text), stage, step);
      if (answer) return answer;

      const halves = splitInHalf(text);
      if (depth >= 2 || halves.length < 2) {
        const err = new Error(
          `The model returned nothing, even for a passage of about ${estimateTokens(text)} tokens.`,
        );
        err.code = 'empty_summary';
        throw err;
      }

      const parts = [];
      for (const half of halves) {
        parts.push(await summarise(half, build, `${stage}, retrying smaller`, step, depth + 1));
      }
      return parts.filter(Boolean).join(' ');
    };

    let summary;
    if (plan.chunks.length === 1) {
      summary = await summarise(plan.chunks[0], (text) => prompts.whole(job.title, text), 'Summarising', 1);
    } else {
      const parts = [];
      for (const [i, chunk] of plan.chunks.entries()) {
        parts.push(await summarise(
          chunk,
          (text) => prompts.section(job.title, text, i + 1, plan.chunks.length),
          `Summarising part ${i + 1} of ${plan.chunks.length}`, i + 1,
        ));
      }

      // Reduce. If the joined section summaries still overflow, fold them in
      // groups until they fit rather than silently truncating.
      let pending = parts;
      let round = reducePlan(pending, plan.budgetTokens);
      while (!round.fits) {
        const folded = [];
        for (const group of round.chunks) {
          folded.push(await summarise(group, (text) => prompts.reduce(job.title, text), 'Condensing'));
        }
        pending = folded;
        round = reducePlan(pending, plan.budgetTokens);
      }

      summary = await summarise(
        round.joined, (text) => prompts.reduce(job.title, text), 'Writing the summary', plan.totalCalls,
      );
    }

    if (!summary) throw new Error('The model returned an empty summary.');

    // A draft stops here: the summary goes back to the reader to edit, and the
    // queue only hears about it if they save.
    if (draft) return update(job, { state: 'drafted', stage: 'Ready to edit', summary });

    update(job, { state: 'writing', stage: 'Saving', summary });

    const settled = await handOff({
      tabId: job.tabId,
      title: job.title,
      url: job.url,
      capturedAt: job.capturedAt,
      mode: 'distill',
      providerId: job.providerId,
      destinationConfig: job.destinationConfig,
      destination: job.destination,
      content: summary,
      // The source rides along only for the local store, which indexes it. A
      // cloud provider is billed on what it extracts and is sent the summary
      // alone, so carrying the article to it would cost money and disk for
      // nothing.
      ...(job.providerId === 'local' ? { sourceText: job.text } : {}),
      chars: summary.length,
      kind: 'summary',
      pagesRead: job.pagesRead,
      pagesTotal: job.pagesTotal,
    });

    // The worker answers in the shape the popup already renders; the summary
    // rides along so the receipt can show what was stored.
    return update(job, { ...settled, summary });
  } catch (err) {
    if (isGpuFault(err)) discardEngine();
    return update(job, { state: 'error', stage: 'Failed', result: { ok: false, ...classify(err, model) } });
  } finally {
    progressListeners.delete(onProgress);
  }
}

/** Turn an engine failure into something with a recovery action attached. */
function classify(err, model) {
  const message = String(err?.message ?? err);

  if (isDeviceLost(err)) {
    return {
      code: 'gpu_device_lost',
      message: 'The graphics driver reset while the model was running, so the summary was lost. '
        + 'The page itself is untouched.',
      // Reloading is usually enough. If it keeps happening on the bigger model,
      // the smaller one asks far less of the GPU.
      recover: model?.id?.includes('3B') ? 'smaller_model' : undefined,
    };
  }

  if (err?.code === 'empty_summary' || /empty summary/i.test(message)) {
    return {
      code: 'empty_summary',
      message: `${message} That usually means the page is not prose the model can summarise.`,
      recover: 'raw',
    };
  }

  if (isGpuFault(err)) {
    // A retry does not reduce memory pressure, and these faults nearly always
    // are memory pressure, so the offer is a model that needs less of it, and
    // only when there is no smaller one left does it become "send page text".
    const smaller = model ? smallerThan(sizeOf(model)) : null;
    return {
      code: 'gpu_fault',
      message: smaller
        ? `The GPU failed part-way through twice. That is almost always memory pressure: `
          + `${MODELS[smaller].label} needs ${Math.round(model.vramMB - MODELS[smaller].vramMB)} MB less.`
        : 'The GPU failed part-way through twice, on the smallest model there is. This machine '
          + 'may not have room to run one at all.',
      recover: smaller ? 'smaller_model' : 'raw',
      smallerModel: smaller,
    };
  }

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
    case MSG.RUN_PDF:
      runPdf(msg);
      return respondAsync(async () => jobs.get(msg.job.tabId) ?? { tabId: msg.job.tabId, state: 'starting' }, respond);
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
        return { ok: true, ...pool.status() };
      }, respond);
    case MSG.ENGINE_STATUS:
      return respondAsync(async () => ({
        ...pool.status(),
        webgpu: Boolean(navigator.gpu),
        persisted: await persistStorage(),
        storage: await storageEstimate(),
      }), respond);
    default:
      return false;
  }
});
