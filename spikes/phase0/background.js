// Service worker. Deliberately does as little as possible: it creates the
// offscreen document and runs the S4 shortcut probe, then is free to die.

const SW_INSTANCE_ID = crypto.randomUUID().slice(0, 8);

async function bumpStartCount() {
  const { swStarts = 0 } = await chrome.storage.session.get('swStarts');
  await chrome.storage.session.set({ swStarts: swStarts + 1, swInstanceId: SW_INSTANCE_ID });
}
bumpStartCount();

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return 'already-open';
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    // No WEBGPU reason exists. WORKERS is the closest honest fit and, unlike
    // AUDIO_PLAYBACK, carries no 30s auto-close.
    reasons: ['WORKERS'],
    justification: 'Runs a local WebGPU language model; service workers have no WebGPU context.',
  });
  return 'created';
}

// S4: does a keyboard shortcut grant activeTab? If this succeeds with only
// "activeTab" + "scripting" in the manifest, the extension never needs host
// permissions for the pages it reads.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'remember-page') return;
  const result = { at: new Date().toISOString(), command };
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ title: document.title, chars: document.body?.innerText?.length ?? 0 }),
    });
    Object.assign(result, { ok: true, url: tab.url, ...injected.result });
    chrome.action.setBadgeText({ text: '✓' });
  } catch (err) {
    Object.assign(result, { ok: false, error: String(err) });
    chrome.action.setBadgeText({ text: '!' });
  }
  await chrome.storage.session.set({ s4: result });
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== 'background') return false;
  if (msg.type === 'ENSURE_OFFSCREEN') {
    ensureOffscreen().then((r) => respond({ ok: true, result: r }), (e) => respond({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'SW_INFO') {
    chrome.storage.session.get(['swStarts', 's4']).then(({ swStarts, s4 }) =>
      respond({ swInstanceId: SW_INSTANCE_ID, swStarts, s4 }));
    return true;
  }
  return false;
});
