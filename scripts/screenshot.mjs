#!/usr/bin/env node
// Screenshots a page of the built extension, in a real Chrome.
//
//   node scripts/screenshot.mjs out.png [popup.html] [light|dark] [width] ["<js first>"] ["<js after>"]
//
// The last script runs after the page has settled, which is where a reload
// belongs: `first` seeds storage and reloads, `after` stages anything the page
// can only learn from a real click (activeTab hands the popup the tab's title
// and URL only when the toolbar button opens it, and nothing clicks it here).
//
// The extension's own pages only render correctly inside an extension origin —
// opening the HTML from disk gives no chrome.* APIs and no theme — so this loads
// dist/ as an unpacked extension and shoots the real thing.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../dist');
const [out, page = 'popup.html', scheme = 'light', width = '420', script = '', after = ''] = process.argv.slice(2);
if (!out) { console.error('usage: screenshot.mjs <out.png> [page] [light|dark] [width] [script]'); process.exit(1); }

const PORT = 9466;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'magpie-shot-'));

const chrome = spawn((process.env.CHROME_PATH ?? '/usr/bin/google-chrome'), [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const http = async (p, init) => (await fetch(`http://127.0.0.1:${PORT}${p}`, init)).json();

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 1;
  const ready = new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const slot = pending.get(m.id);
    if (!slot) return;
    pending.delete(m.id);
    m.error ? slot.rej(new Error(JSON.stringify(m.error))) : slot.res(m.result);
  };
  return {
    ready,
    send: (method, params = {}) => new Promise((res, rej) => {
      const n = id++;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
  };
}

try {
  await sleep(2500);
  const sw = (await http('/json/list')).find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
  if (!sw) throw new Error('the extension did not load — try: npm run build');
  const extId = new URL(sw.url).host;

  const opened = await http(`/json/new?chrome-extension://${extId}/${page}`, { method: 'PUT' });
  await sleep(1200);
  const target = (await http('/json/list')).find((t) => t.id === opened.id);

  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Number(width), height: 900, deviceScaleFactor: 2, mobile: false,
  });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });

  if (script) {
    const { exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  // Fonts are self-hosted and still need a moment to paint.
  await sleep(700);

  if (after) {
    const { exceptionDetails } = await cdp.send('Runtime.evaluate', { expression: after, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    await sleep(200);
  }

  // Shrink the frame to what was actually drawn. The popup is a panel, not a
  // page: it is as tall as its content and no taller, so capturing a fixed
  // viewport left a picture that was mostly empty paper below the panel and
  // read, in a README, as an enormous image of nothing.
  const { result: measured } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      let bottom = 0;
      for (const el of document.body.querySelectorAll('*')) {
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        bottom = Math.max(bottom, box.bottom);
      }
      const pad = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
      return Math.ceil(bottom + pad) || document.body.scrollHeight;
    })()`,
    returnByValue: true,
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Number(width), height: measured.value, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(200);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`${out}  (${page}, ${scheme}, ${width}px)`);
} finally {
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
