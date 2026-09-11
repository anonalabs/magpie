// Service worker. Starts captures and gets out of the way.
//
// Phase-0 spike (see spikes/phase0) established that the offscreen document
// outlives this worker and that a job started before the worker dies still
// completes. So nothing here keeps the worker alive on purpose: no keepalive
// ping, no port held open. A distill is handed to the offscreen document, which
// owns it through to the provider write.

import { MSG, TO_BACKGROUND, respondAsync, toOffscreen } from './lib/messages.js';
import { loadSettings, providerConfig } from './lib/settings.js';
import { push } from './lib/providers/registry.js';
import { MODELS } from './lib/models.js';

const RAW_STATE_KEY = (tabId) => `raw:${tabId}`;
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

export async function startCapture(tabId) {
  badge(tabId, 'working');
  const settings = await loadSettings();
  const config = providerConfig(settings);

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
    mode: settings.mode,
    providerId: settings.providerId,
  };

  if (settings.mode === 'raw') {
    // No model, no offscreen document, one short fetch — this stays in the worker.
    await setRawState(tabId, { ...base, state: 'writing' });
    const result = await push(settings.providerId, { ...base, content: article.text }, config);
    const finished = {
      ...base,
      state: result.ok ? 'remembered' : 'error',
      result,
      stored: { chars: article.text.length, kind: 'article text' },
    };
    await setRawState(tabId, finished);
    badge(tabId, result.ok ? 'ok' : 'error');
    return finished;
  }

  await ensureOffscreen();
  // The key is relayed in because offscreen documents support only
  // chrome.runtime — chrome.storage is not available to them.
  return toOffscreen(MSG.RUN_DISTILL, {
    job: { ...base, text: article.text },
    model: MODELS[settings.modelSize] ?? MODELS.small,
    providerConfig: config,
  });
}

async function fail(tabId, error) {
  const state = { tabId, state: 'error', result: { ok: false, ...error } };
  await setRawState(tabId, state);
  badge(tabId, 'error');
  return state;
}

// Session storage, not local: a capture receipt is worth keeping while the
// browser is open and worth forgetting when it closes.
const setRawState = (tabId, state) => chrome.storage.session.set({ [RAW_STATE_KEY(tabId)]: state });

async function captureState(tabId) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) {
    const job = await toOffscreen(MSG.GET_JOB, { tabId });
    if (job) return job;
  }
  return (await chrome.storage.session.get(RAW_STATE_KEY(tabId)))[RAW_STATE_KEY(tabId)] ?? null;
}

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
async function syncInPage() {
  const granted = await chrome.permissions.contains(IN_PAGE_ORIGINS);
  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [IN_PAGE_SCRIPT_ID] })
    .catch(() => []);

  if (!granted) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [IN_PAGE_SCRIPT_ID] });
    return { registered: false };
  }
  if (existing.length) return { registered: true };

  await chrome.scripting.registerContentScripts([{
    id: IN_PAGE_SCRIPT_ID,
    js: ['in-page.js'],
    matches: ['http://*/*', 'https://*/*'],
    runAt: 'document_idle',
    // Top frame only: every ad slot and embedded player is also a frame.
    allFrames: false,
    persistAcrossSessions: true,
  }]);
  return { registered: true };
}

chrome.runtime.onStartup.addListener(syncInPage);
chrome.runtime.onInstalled.addListener(syncInPage);
chrome.permissions.onAdded.addListener(syncInPage);
chrome.permissions.onRemoved.addListener(syncInPage);

// ---------------------------------------------------------------- wiring ----
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'remember-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await startCapture(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigated tab is a different page; the old receipt no longer describes it.
  if (changeInfo.url) badge(tabId, 'clear');
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.target !== TO_BACKGROUND) return false;

  switch (msg.type) {
    case MSG.START_CAPTURE:
      return respondAsync(() => startCapture(msg.tabId), respond);
    case MSG.START_CAPTURE_FROM_PAGE:
      // The page never names a tab; the only trustworthy id is the sender's.
      return respondAsync(async () => {
        if (sender.tab?.id == null) return { state: 'error', result: { ok: false, message: 'No tab to capture.' } };
        return startCapture(sender.tab.id);
      }, respond);
    case MSG.SYNC_IN_PAGE:
      return respondAsync(syncInPage, respond);
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
