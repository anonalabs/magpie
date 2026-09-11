// The floating button, injected into pages only while the optional all-sites
// permission is granted (see popup.js). Registered dynamically by the service
// worker, never declared in the manifest, so revoking the permission actually
// removes it rather than leaving it declared and inert.
//
// Everything lives inside a shadow root. A page's own stylesheet cannot reach in
// and this button's styles cannot leak out — the alternative is a button that
// inherits some site's `button { width: 100% }` and covers the article.

const HOST_ID = 'magpie-in-page-root';
const STORE = `magpie:in-page:${location.origin}`;

// Only the top document. Injecting into every iframe would put a button on each
// ad slot and embedded player on the page.
if (window.top === window && !document.getElementById(HOST_ID)) init();

async function init() {
  const saved = (await chrome.storage.local.get(STORE))[STORE] ?? {};
  if (saved.hidden) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Inline, and !important: a page's own `div { position: static }` or a low
  // stacking context would otherwise bury the button inside the article.
  host.style.cssText = 'position:fixed!important;z-index:2147483646!important;bottom:22%;right:14px;' +
    'width:auto!important;height:auto!important;margin:0!important;padding:0!important;border:0!important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.append(style(), ...widget());
  (document.body ?? document.documentElement).append(host);

  const button = root.getElementById('button');
  const label = root.getElementById('label');
  const dismiss = root.getElementById('dismiss');

  place(host, saved);

  // ---- state ------------------------------------------------------------
  let resetTimer = null;
  const setState = (state, text) => {
    clearTimeout(resetTimer);
    button.dataset.state = state;
    label.textContent = text ?? '';
    button.title = text ? `magpie — ${text}` : 'Remember this page';
    // A receipt that never clears would read as the state of the next page too.
    if (state === 'good' || state === 'bad') {
      resetTimer = setTimeout(() => { button.dataset.state = 'idle'; label.textContent = ''; }, 4000);
    }
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'JOB_UPDATE') return false;
    const job = msg.job ?? {};
    if (job.state === 'remembered') setState('good', 'Remembered');
    else if (job.state === 'error') setState('bad', job.result?.message ?? 'Failed');
    else setState('busy', job.stage ?? 'Working');
    return false;
  });

  // ---- press vs drag ----------------------------------------------------
  // One pointer gesture has to serve both, so a press only counts as a click if
  // the pointer barely moved; anything more is a drag and must not fire a
  // capture the reader did not ask for.
  let origin = null;
  let dragged = false;

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    origin = { y: event.clientY, top: host.getBoundingClientRect().top };
    dragged = false;
    button.setPointerCapture(event.pointerId);
  });

  button.addEventListener('pointermove', (event) => {
    if (!origin) return;
    const delta = event.clientY - origin.y;
    if (Math.abs(delta) < 4 && !dragged) return;
    dragged = true;
    host.style.top = `${clamp(origin.top + delta, 8, window.innerHeight - 56)}px`;
    host.style.bottom = 'auto';
  });

  button.addEventListener('pointerup', async (event) => {
    if (!origin) return;
    button.releasePointerCapture(event.pointerId);
    const wasDrag = dragged;
    origin = null;

    if (wasDrag) {
      const side = event.clientX > window.innerWidth / 2 ? 'right' : 'left';
      const top = host.getBoundingClientRect().top;
      host.dataset.side = side;
      place(host, { side, top });
      await chrome.storage.local.set({ [STORE]: { side, top } });
      return;
    }

    setState('busy', 'Reading the page');
    const job = await chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE_FROM_PAGE' });
    if (job?.state === 'error') setState('bad', job.result?.message ?? 'Failed');
  });

  dismiss.addEventListener('click', async (event) => {
    event.stopPropagation();
    await chrome.storage.local.set({ [STORE]: { ...saved, hidden: true } });
    host.remove();
  });
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function place(host, { side = 'right', top } = {}) {
  host.dataset.side = side;
  host.style.left = side === 'left' ? '14px' : 'auto';
  host.style.right = side === 'right' ? '14px' : 'auto';
  if (top != null) { host.style.top = `${clamp(top, 8, window.innerHeight - 56)}px`; host.style.bottom = 'auto'; }
}

function widget() {
  const button = document.createElement('button');
  button.id = 'button';
  button.type = 'button';
  button.dataset.state = 'idle';
  button.title = 'Remember this page';
  button.innerHTML = `
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs><clipPath id="c"><rect width="32" height="32" rx="8"/></clipPath></defs>
      <g clip-path="url(#c)">
        <rect width="32" height="32" fill="#17160f"/>
        <circle cx="6.4" cy="30.4" r="16" fill="#f4f1ea"/>
        <circle cx="21.8" cy="10.2" r="4.6" fill="#57b184"/>
      </g>
    </svg>
    <span id="label"></span>`;

  const dismiss = document.createElement('button');
  dismiss.id = 'dismiss';
  dismiss.type = 'button';
  dismiss.title = 'Hide magpie on this site';
  dismiss.textContent = '×';

  return [button, dismiss];
}

function style() {
  const el = document.createElement('style');
  el.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }

    #button {
      display: flex; align-items: center; gap: 8px;
      height: 38px; padding: 0 9px;
      background: #fbfaf8; color: #17160f;
      border: 1px solid rgba(0,0,0,.1); border-radius: 999px;
      box-shadow: 0 2px 6px rgba(0,0,0,.10), 0 8px 24px rgba(0,0,0,.10);
      cursor: pointer; opacity: .55;
      font-size: 12px; font-weight: 600; line-height: 1;
      transition: opacity .18s cubic-bezier(.16,1,.3,1), box-shadow .18s cubic-bezier(.16,1,.3,1);
      touch-action: none;
    }
    #button:hover, #button[data-state="busy"], #button[data-state="good"], #button[data-state="bad"] { opacity: 1; }
    #button:hover { box-shadow: 0 3px 8px rgba(0,0,0,.13), 0 12px 30px rgba(0,0,0,.13); }
    #button:focus-visible { outline: 2px solid #1c6b46; outline-offset: 2px; }

    #button svg { width: 20px; height: 20px; flex: none; border-radius: 6px; }

    /* The label is absent at rest, so the button is a dot until it has something
       to say. It only earns width while a capture is in flight or just done. */
    #label:empty { display: none; }
    #label { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    #button[data-state="busy"] svg { animation: pulse 1.3s cubic-bezier(.16,1,.3,1) infinite; }
    #button[data-state="good"] { color: #1c6b46; }
    #button[data-state="bad"] { color: #9c3418; }
    @keyframes pulse { 50% { opacity: .45; } }

    #dismiss {
      position: absolute; top: -6px; right: -6px;
      width: 17px; height: 17px; padding: 0;
      display: none; place-items: center;
      font-size: 12px; line-height: 1;
      color: #fbfaf8; background: #17160f;
      border: 0; border-radius: 999px; cursor: pointer;
    }
    :host(:hover) #dismiss { display: grid; }

    @media (prefers-color-scheme: dark) {
      #button { background: #1c1b14; color: #f4f2ec; border-color: rgba(255,255,255,.12); }
      #button[data-state="good"] { color: #57b184; }
      #button[data-state="bad"] { color: #e08a72; }
      #dismiss { color: #17160f; background: #f4f2ec; }
    }

    @media (prefers-reduced-motion: reduce) {
      #button, #button svg { transition: none; animation: none; }
    }

    @media print { :host { display: none; } }
  `;
  return el;
}
