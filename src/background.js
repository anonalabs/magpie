// Service worker. Starts captures and gets out of the way.
//
// Phase-0 spike (see spikes/phase0) established that the offscreen document
// outlives this worker and that a job started before the worker dies still
// completes. So nothing here keeps the worker alive on purpose: no keepalive
// ping, no port held open. A distill is handed to the offscreen document, which
// owns it through to the provider write.

import { MSG, TO_BACKGROUND, respondAsync, toOffscreen } from './lib/messages.js';
import { loadSettings, providerConfig } from './lib/settings.js';
import { push, getProvider } from './lib/providers/registry.js';
import { MODELS } from './lib/models.js';
import * as captures from './lib/captures.js';
import { settle } from './lib/queue.js';
import { composeContent } from './lib/compose.js';

const DRAIN_ALARM = 'magpie-drain';
const IN_PAGE_SCRIPT_ID = 'magpie-in-page';
// Web pages only. <all_urls> would also cover file:// and ftp://, which the
// button never runs on, and would make the permission prompt larger for nothing.
const IN_PAGE_ORIGINS = { origins: ['http://*/*', 'https://*/*'] };

// ---------------------------------------------------------------- badge ----
// The entire UI for the keyboard-shortcut path, which never opens the popup.
const BADGE = {
  working: { text: '…', color: '#6b7280' },
  ok: { text: '✓', color: '#15803d' },
  error: { text: '!', color: '#b91c1c' },
  clear: { text: '', color: '#6b7280' },
};

function badge(tabId, kind) {
  const { text, color } = BADGE[kind];
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ------------------------------------------------------------- offscreen ----
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  // Two captures fired in quick succession would otherwise both try to create it
  // and the second would throw "Only a single offscreen document may be created".
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      // There is no WEBGPU reason. WORKERS is the closest honest fit, and unlike
      // AUDIO_PLAYBACK it carries no 30-second auto-close, so the loaded model
      // stays resident between captures.
      reasons: ['WORKERS'],
      justification: 'Runs a local language model on WebGPU, which service workers cannot access.',
    }).finally(() => { creating = null; });
  }
  await creating;
}

// --------------------------------------------------------------- capture ----
async function extractActiveTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.MAGPIE_EXTRACT(),
  });
  return result;
}

/**
 * `mode` overrides the setting for this capture alone and never writes it back.
 * The recovery buttons use it: "Send the page text instead" used to call
 * saveSettings, so one click in an error dialog silently moved every future
 * capture to sending whole articles — 270x the content at the provider, and
 * priced on it. A button that reads as "just this once" has to be just this once.
 */
export async function startCapture(tabId, mode) {
  badge(tabId, 'working');
  const settings = await loadSettings();
  const effectiveMode = mode ?? settings.mode;

  let article;
  try {
    article = await extractActiveTab(tabId);
  } catch (err) {
    // Chrome refuses injection on its own pages, the Web Store, and PDFs.
    const blocked = /cannot be scripted|Extension manifest|chrome:\/\//i.test(String(err?.message));
    return fail(tabId, {
      code: blocked ? 'page_not_supported' : 'extract_failed',
      message: blocked
        ? 'Chrome does not allow extensions to read this page.'
        : `Could not read this page. ${err?.message ?? err}`,
    });
  }

  if (!article?.ok) return fail(tabId, article ?? { code: 'extract_failed', message: 'Could not read this page.' });

  const base = {
    tabId,
    title: article.title,
    url: article.url,
    capturedAt: new Date().toISOString(),
    mode: effectiveMode,
    providerId: settings.providerId,
    destination: describeDestination(settings),
  };

  if (effectiveMode === 'raw') {
    // No model and no offscreen document: straight into the queue.
    return jobFromRecord(await commit({ ...base, content: article.text, kind: 'article text' }));
  }

  await ensureOffscreen();
  // The key is relayed in because offscreen documents support only
  // chrome.runtime — chrome.storage is not available to them.
  return toOffscreen(MSG.RUN_DISTILL, {
    job: { ...base, text: article.text },
    model: MODELS[settings.modelSize] ?? MODELS.small,
  });
}

function describeDestination(settings) {
  const provider = getProvider(settings.providerId);
  const space = settings.providers?.[settings.providerId]?.spaceId;
  return space ? `${provider.label} · ${space}` : provider.label;
}

/**
 * The durability point. The capture is on disk before any network call, so a
 * failed write is a retry rather than lost work.
 */
async function commit(record) {
  // Composed once, here, so the record on disk is exactly what will be sent —
  // a retry never has to reassemble anything.
  const stored = await captures.enqueue({
    ...record,
    sourceKind: record.sourceKind ?? 'page',
    content: composeContent(record.note, record.content),
  });
  badge(record.tabId, 'working');
  const settled = await send(stored);
  await scheduleDrain();
  return settled;
}

async function send(record) {
  const settings = await loadSettings();
  const config = settings.providers?.[record.providerId] ?? {};
  const result = await push(record.providerId, {
    title: record.title,
    url: record.url,
    content: record.content,
    capturedAt: record.capturedAt,
    mode: record.mode,
    note: record.note,
    sourceKind: record.sourceKind,
  }, config);

  const settled = settle(record, result);
  await captures.replace(settled);

  if (record.tabId != null) {
    badge(record.tabId, settled.state === 'done' ? 'ok' : settled.state === 'blocked' ? 'error' : 'working');
  }
  broadcast(settled);
  return settled;
}

let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (const record of await captures.due()) await send(record);
  } finally {
    draining = false;
  }
  await scheduleDrain();
}

/**
 * One alarm for the soonest due record. Alarms outlive the worker; timers do not.
 *
 * Guarded, because chrome.alarms is undefined without its permission — and a
 * permission added in a new build is invisible to Chrome until the extension is
 * reloaded, not merely rebuilt. Calling it unguarded at the top of the worker
 * threw during startup, which killed the whole worker and made every capture
 * fail with no useful message. A scheduling API that is missing should cost
 * scheduled retries, not the extension.
 */
async function scheduleDrain() {
  if (!chrome.alarms) return;
  const at = await captures.nextDueAt();
  await chrome.alarms.clear(DRAIN_ALARM);
  if (at) await chrome.alarms.create(DRAIN_ALARM, { when: at });
}

chrome.alarms?.onAlarm.addListener((alarm) => { if (alarm.name === DRAIN_ALARM) drain(); });
chrome.runtime.onStartup.addListener(drain);

/** A capture record in the shape the popup already renders. */
function jobFromRecord(record) {
  if (!record) return null;
  const state = record.state === 'done' ? 'remembered' : record.state === 'blocked' ? 'error' : 'queued';
  return {
    ...record,
    state,
    stage: { remembered: 'Remembered', error: 'Could not save', queued: 'Saved here, will retry' }[state],
    result: record.state === 'done'
      ? { ok: true, providerLabel: record.destination, state: 'queued' }
      : { ok: false, ...(record.lastError ?? {}) },
    stored: record.chars ? { chars: record.chars, kind: record.kind ?? 'summary' } : null,
  };
}

const broadcast = (record) =>
  chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job: jobFromRecord(record) }).catch(() => {});

async function fail(tabId, error) {
  const state = { tabId, state: 'error', result: { ok: false, ...error } };
  badge(tabId, 'error');
  broadcast(null);
  chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job: state }).catch(() => {});
  return state;
}

async function captureState(tabId) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) {
    const job = await toOffscreen(MSG.GET_JOB, { tabId });
    if (job) return job;
  }
  const record = (await captures.readAll()).find((r) => r.tabId === tabId);
  return jobFromRecord(record);
}

// --------------------------------------------------------------- compose ----
/**
 * Starts a capture the reader will annotate.
 *
 * The distill begins immediately and the answer comes back before it finishes,
 * so the note is written while the model runs. The waiting time becomes the
 * typing time instead of being added to it.
 */
async function startCompose(tabId) {
  const settings = await loadSettings();

  let article;
  try {
    article = await extractActiveTab(tabId);
  } catch (err) {
    return { ok: false, code: 'extract_failed', message: `Could not read this page. ${err?.message ?? err}` };
  }
  if (!article?.ok) return { ok: false, ...(article ?? { code: 'extract_failed', message: 'Could not read this page.' }) };

  const base = {
    ok: true,
    tabId,
    title: article.title,
    url: article.url,
    mode: settings.mode,
    destination: describeDestination(settings),
  };

  // Raw mode has nothing to wait for: the body is the article text.
  if (settings.mode === 'raw') return { ...base, body: article.text, ready: true };

  await ensureOffscreen();
  toOffscreen(MSG.RUN_DISTILL, {
    job: { ...base, capturedAt: new Date().toISOString(), providerId: settings.providerId },
    model: MODELS[settings.modelSize] ?? MODELS.small,
    draft: true,
  });
  // The summary arrives later as a JOB_UPDATE in the 'drafted' state.
  return { ...base, body: '', ready: false };
}

async function saveCompose(draft) {
  const settings = await loadSettings();
  const content = (draft.content ?? '').trim();
  if (!content && !(draft.note ?? '').trim()) {
    return { state: 'error', result: { ok: false, code: 'nothing_to_save', message: 'There is nothing to save.' } };
  }

  return jobFromRecord(await commit({
    tabId: draft.tabId,
    title: draft.title,
    url: draft.url,
    capturedAt: new Date().toISOString(),
    mode: draft.mode,
    sourceKind: draft.sourceKind ?? 'page',
    note: draft.note,
    providerId: settings.providerId,
    destination: describeDestination(settings),
    content,
    chars: content.length,
    kind: draft.mode === 'raw' ? 'article text' : 'summary',
  }));
}

/**
 * A keyboard shortcut cannot open the popup before Chrome 127. Where it can,
 * it does; where it cannot, the request is parked and the badge marks it, so
 * the next time the popup is opened it opens into compose. The shortcut never
 * silently does nothing.
 */
async function requestCompose(tabId) {
  await chrome.storage.session.set({ pendingCompose: tabId });
  try {
    await chrome.action.openPopup();
  } catch {
    badge(tabId, 'working');
  }
}

// ------------------------------------------------------------- selection ----
const SELECTION_MENU_ID = 'magpie-remember-selection';

/**
 * Guarded like the alarms listener: a permission added in a build is invisible
 * to Chrome until the extension is reloaded, and an unguarded call to a missing
 * API at the top of the worker kills the worker and every capture with it.
 */
function installMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SELECTION_MENU_ID,
      title: 'Remember this selection',
      contexts: ['selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

/**
 * A selection is stored exactly as selected: no model, instant, and it works on
 * a machine with no WebGPU. You already chose those words — summarising them
 * into a shorter paraphrase discards the only thing the selection had.
 */
async function captureSelection(tab, info) {
  if (tab?.id == null) return null;
  badge(tab.id, 'working');

  // info.selectionText is TRUNCATED by Chrome. Reading the live selection is
  // the difference between storing a quote and storing a clipped one, which is
  // the kind of bug nobody notices until the memory is useless.
  let text = '';
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection()?.toString() ?? ''),
    });
    text = result ?? '';
  } catch {
    text = info?.selectionText ?? '';
  }
  if (!text.trim()) text = info?.selectionText ?? '';

  if (!text.trim()) {
    return fail(tab.id, { code: 'no_selection', message: 'Nothing was selected on the page.' });
  }

  const settings = await loadSettings();
  return jobFromRecord(await commit({
    tabId: tab.id,
    title: tab.title || tab.url,
    url: tab.url,
    capturedAt: new Date().toISOString(),
    mode: 'selection',
    sourceKind: 'selection',
    providerId: settings.providerId,
    destination: describeDestination(settings),
    content: text.trim(),
    chars: text.trim().length,
    kind: 'selection',
  }));
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SELECTION_MENU_ID) captureSelection(tab, info);
});

// ---------------------------------------------------- in-page button ----
/**
 * Registers or removes the floating in-page button to match the optional
 * all-sites permission.
 *
 * Registered dynamically rather than declared in the manifest: a declared
 * content script is part of the install prompt forever, whereas this one exists
 * only while the permission does, so revoking it genuinely removes the script
 * instead of leaving it declared and silently inert.
 */
/**
 * Brings the in-page button into line with the optional permission, and reports
 * exactly what happened at every step.
 *
 * It never throws. It used to, and the caller reported "Done." regardless — so a
 * failed registration produced a success message and no button, which is
 * indistinguishable from the feature simply not working.
 */
async function syncInPage() {
  const status = { granted: false, registered: false, injected: 0, error: null };

  try {
    status.granted = await chrome.permissions.contains(IN_PAGE_ORIGINS);

    // Always cleared first, never "it exists so we are done". Registrations
    // persist across sessions, so an old one made by a previous version survives
    // an update — with that version's match patterns. Treating it as current
    // left a registration that matched nothing.
    await chrome.scripting.unregisterContentScripts({ ids: [IN_PAGE_SCRIPT_ID] }).catch(() => {});
    if (!status.granted) return status;

    await chrome.scripting.registerContentScripts([{
      id: IN_PAGE_SCRIPT_ID,
      js: ['in-page.js'],
      matches: IN_PAGE_ORIGINS.origins,
      runAt: 'document_idle',
      // Top frame only: every ad slot and embedded player is also a frame.
      allFrames: false,
      persistAcrossSessions: true,
    }]);
    status.registered = true;

    // A content script only applies to pages loaded after it is registered, so
    // without this the button appears on nothing already open — including the
    // tab the reader was on when they turned it on.
    status.injected = await injectIntoOpenTabs();
  } catch (err) {
    status.error = String(err?.message ?? err);
  }

  await chrome.storage.session.set({ inPageStatus: status }).catch(() => {});
  return status;
}

/** The truth, for the settings panel: asked fresh rather than read from a cache. */
async function inPageStatus() {
  const granted = await chrome.permissions.contains(IN_PAGE_ORIGINS).catch(() => false);
  const registered = (await chrome.scripting
    .getRegisteredContentScripts({ ids: [IN_PAGE_SCRIPT_ID] })
    .catch(() => [])).length > 0;
  const last = (await chrome.storage.session.get('inPageStatus').catch(() => ({}))).inPageStatus ?? {};
  return { granted, registered, error: last.error ?? null, injected: last.injected ?? 0 };
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: IN_PAGE_ORIGINS.origins }).catch(() => []);
  let injected = 0;
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id == null) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['in-page.js'] });
      injected++;
    } catch {
      // A tab can be discarded, still loading, or a page Chrome will not script.
      // None of those is worth failing the whole switch-on for.
    }
  }));
  return injected;
}

chrome.runtime.onStartup.addListener(syncInPage);
chrome.runtime.onInstalled.addListener(syncInPage);
chrome.permissions.onAdded.addListener(syncInPage);
chrome.permissions.onRemoved.addListener(syncInPage);

// ---------------------------------------------------------------- wiring ----
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  if (command === 'remember-page') await startCapture(tab.id);
  if (command === 'compose-capture') await requestCompose(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigated tab is a different page; the old receipt no longer describes it.
  if (changeInfo.url) badge(tabId, 'clear');
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.target !== TO_BACKGROUND) return false;

  switch (msg.type) {
    case MSG.START_CAPTURE:
      return respondAsync(() => startCapture(msg.tabId, msg.mode), respond);
    case MSG.START_CAPTURE_FROM_PAGE:
      // The page never names a tab; the only trustworthy id is the sender's.
      return respondAsync(async () => {
        if (sender.tab?.id == null) return { state: 'error', result: { ok: false, message: 'No tab to capture.' } };
        return startCapture(sender.tab.id);
      }, respond);
    case MSG.SYNC_IN_PAGE:
      return respondAsync(syncInPage, respond);
    case MSG.IN_PAGE_STATUS:
      return respondAsync(inPageStatus, respond);
    case MSG.ENQUEUE:
      // Sent by the offscreen document once a summary exists. It cannot reach
      // chrome.storage itself, and this message is what wakes the worker.
      return respondAsync(() => commit(msg.record), respond);
    case MSG.LIST_CAPTURES:
      return respondAsync(captures.readAll, respond);
    case MSG.RETRY_CAPTURE:
      return respondAsync(async () => {
        const record = (await captures.readAll()).find((r) => r.id === msg.id);
        if (!record) return null;
        return send({ ...record, state: 'pending', attempts: 0, nextAttemptAt: Date.now() });
      }, respond);
    case MSG.DELETE_CAPTURE:
      return respondAsync(async () => { await captures.remove(msg.id); return { ok: true }; }, respond);
    case MSG.START_COMPOSE:
      return respondAsync(() => startCompose(msg.tabId), respond);
    case MSG.SAVE_COMPOSE:
      return respondAsync(() => saveCompose(msg.draft), respond);
    case MSG.PENDING_COMPOSE:
      return respondAsync(async () => {
        const { pendingCompose } = await chrome.storage.session.get('pendingCompose');
        if (pendingCompose != null) await chrome.storage.session.remove('pendingCompose');
        return { tabId: pendingCompose ?? null };
      }, respond);
    case MSG.GET_CAPTURE_STATE:
      return respondAsync(() => captureState(msg.tabId), respond);
    case MSG.PRELOAD_MODEL:
      return respondAsync(async () => {
        await ensureOffscreen();
        const settings = await loadSettings();
        return toOffscreen(MSG.PRELOAD_MODEL, { model: MODELS[settings.modelSize] ?? MODELS.small });
      }, respond);
    default:
      return false;
  }
});

// Progress and completion arrive from the offscreen document; the popup listens
// for them directly. The worker only needs them to paint the badge, which is the
// one piece of feedback the shortcut path has.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'JOB_UPDATE' || msg.job?.tabId == null) return false;
  if (msg.job.state === 'remembered') badge(msg.job.tabId, 'ok');
  else if (msg.job.state === 'error') badge(msg.job.tabId, 'error');

  // runtime.sendMessage does not reach content scripts, so the in-page button
  // is told separately. It may not be there at all, which is not an error.
  chrome.tabs.sendMessage(msg.job.tabId, { type: 'JOB_UPDATE', job: msg.job }).catch(() => {});
  return false;
});
