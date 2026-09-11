#!/usr/bin/env node
// End-to-end test against a real Chrome and the real provider adapter.
//
// api.anonalabs.com is pointed at a local HTTPS server with --host-resolver-rules,
// so the request under test is the one the extension would actually send: same
// fetch, same headers, same host permission, same CORS treatment. Nothing is
// stubbed inside the extension.
//
// The distill path needs WebGPU and is therefore not covered here — see the
// note printed at the end.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PORT_CDP = 9411, PORT_WEB = 8411, PORT_API = 8443;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --------------------------------------------------------------- servers ----
const work = mkdtempSync(join(tmpdir(), 'magpie-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'),
  '-subj', '/CN=api.anonalabs.com'], { stdio: 'ignore' });

const received = [];
const SPACES = {
  spaces: [
    { space_id: 'default', name: 'Default' },
    { space_id: 'reading', name: 'Reading list' },
    // Same bare name as the caller's own: only the qualified form can address it.
    { space_id: 'default', name: 'Default', shared_by: 'Acme', qualified_id: 'acme:default' },
  ],
  total: 3,
};

const api = createHttps(
  { key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) },
  (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, body: safeJson(body) });
      if (req.method === 'GET' && req.url === '/v1/spaces') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(SPACES));
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job_test_1', status: 'processing' }));
    });
  },
).listen(PORT_API);

const web = createServer((req, res) => {
  const name = req.url === '/empty' ? 'empty.html' : 'article.html';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(join(HERE, 'fixtures', name)));
}).listen(PORT_WEB);

const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

// ------------------------------------------------------- extension build ----
// A copy of dist with one extra host permission, so executeScript works without
// a real toolbar click (activeTab needs a user gesture CDP cannot produce). The
// activeTab grant itself is covered by spike S4.
const EXT = join(work, 'ext');
cpSync(join(ROOT, 'dist'), EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions.push(`http://127.0.0.1:${PORT_WEB}/*`);
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ------------------------------------------------------------------ cdp ----
const profile = mkdtempSync(join(tmpdir(), 'magpie-profile-'));
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  `--host-resolver-rules=MAP api.anonalabs.com 127.0.0.1:${PORT_API}`,
  '--ignore-certificate-errors',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

function shutdown(code) {
  try { chrome.kill('SIGKILL'); } catch {}
  api.close(); web.close();
  // Chrome may still be flushing its profile as it dies.
  const wipe = (p) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} };
  wipe(work); wipe(profile);
  process.exit(code);
}

const http = async (p) => (await fetch(`http://127.0.0.1:${PORT_CDP}${p}`)).json();

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 1;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const slot = pending.get(m.id);
    if (!slot) return;
    pending.delete(m.id);
    m.error ? slot.reject(new Error(JSON.stringify(m.error))) : slot.resolve(m.result);
  };
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = id++;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
  };
}

async function waitFor(fn, what, tries = 80) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(400); }
  throw new Error(`timed out waiting for ${what}`);
}

async function evalIn(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

// ----------------------------------------------------------------- main ----
async function main() {
  const version = await waitFor(async () => { try { return await http('/json/version'); } catch { return null; } }, 'chrome');
  console.log(`${version.Browser}\n`);
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  const extId = await waitFor(async () => {
    const t = (await http('/json/list')).find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    return t ? new URL(t.url).host : null;
  }, 'the extension service worker');
  check('extension loads', true, extId);

  // Open the popup as a page: it has the same extension APIs, so it can drive
  // settings and messages exactly as the real popup does.
  const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const cdp = await waitFor(async () => {
    const t = (await http('/json/list')).find((x) => x.id === targetId);
    if (!t?.webSocketDebuggerUrl) return null;
    const c = connect(t.webSocketDebuggerUrl);
    await c.ready; await c.send('Runtime.enable');
    const { result } = await c.send('Runtime.evaluate', { expression: 'typeof chrome?.runtime?.id === "string"', returnByValue: true });
    return result.value ? c : null;
  }, 'the popup page');

  // A tab holding the fixture article.
  const { targetId: articleTab } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT_WEB}/` });
  await sleep(1200);
  const tabId = await evalIn(cdp, `
    const tabs = await chrome.tabs.query({});
    // tab.url is undefined for tabs the extension holds no permission on.
    const t = tabs.find(t => (t.url ?? '').startsWith('http://127.0.0.1:${PORT_WEB}/') && !(t.url ?? '').endsWith('/empty'));
    return t?.id ?? null;`);
  check('fixture tab found', tabId != null, `tabId ${tabId}`);

  // ---- raw mode, end to end -------------------------------------------
  await evalIn(cdp, `
    await chrome.storage.local.set({ settings: {
      mode: 'raw', modelSize: 'small', providerId: 'anona',
      providers: { anona: { apiKey: 'anona_live_testkey', spaceId: 'magpie-test' } },
    }});
    return true;`);

  const raw = await evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE', tabId: ${tabId} });`);

  check('raw capture reports remembered', raw?.state === 'remembered', `state "${raw?.state}" ${raw?.result?.message ?? ''}`);
  check('receipt says which provider accepted it', raw?.result?.state === 'queued' && raw?.result?.providerLabel === 'Anona Memory',
    `${raw?.result?.providerLabel} / ${raw?.result?.state}`);

  const sent = received.filter((r) => r.url === '/v1/record').at(-1);
  check('request reached the provider', Boolean(sent), sent ? `${sent.method} ${sent.url}` : 'nothing arrived');
  if (sent) {
    check('hits POST /v1/record', sent.method === 'POST' && sent.url === '/v1/record', sent.url);
    check('sends the bearer key', sent.headers.authorization === 'Bearer anona_live_testkey');
    check('body has exactly the declared fields',
      JSON.stringify(Object.keys(sent.body).sort()) === JSON.stringify(['async', 'content', 'metadata', 'space_id', 'tags']),
      Object.keys(sent.body).sort().join(','));
    check('space id is the configured one', sent.body.space_id === 'magpie-test', sent.body.space_id);
    check('content is the article, not the boilerplate',
      sent.body.content.includes('value 700 was recorded') && !sent.body.content.includes('Boilerplate footer'),
      `${sent.body.content.length} chars`);
    check('metadata carries the page identity',
      sent.body.metadata?.title === 'The Test Article' && sent.body.metadata?.url?.startsWith('http://127.0.0.1'),
      sent.body.metadata?.title);
  }

  // ---- a page with nothing to read -------------------------------------
  const { targetId: emptyTab } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT_WEB}/empty` });
  await sleep(1000);
  const emptyId = await evalIn(cdp, `
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => (t.url ?? '').endsWith('/empty'))?.id ?? null;`);
  const before = received.filter((r) => r.url === '/v1/record').length;
  const empty = await evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE', tabId: ${emptyId} });`);
  check('a page with no article fails clearly', empty?.state === 'error' && empty?.result?.code === 'no_article',
    empty?.result?.code ?? empty?.state);
  const after = received.filter((r) => r.url === '/v1/record').length;
  check('and nothing is sent anywhere', after === before, `${after - before} extra writes`);

  // ---- the space picker -------------------------------------------------
  // A fresh popup, with a key already saved: the list should fill itself with no
  // button press, because that is the ordinary case.
  const { targetId: settingsTab } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const cdpSettings = await waitFor(async () => {
    const t = (await http('/json/list')).find((x) => x.id === settingsTab);
    if (!t?.webSocketDebuggerUrl) return null;
    const c = connect(t.webSocketDebuggerUrl); await c.ready; await c.send('Runtime.enable');
    const { result } = await c.send('Runtime.evaluate', { expression: 'typeof chrome?.runtime?.id === "string"', returnByValue: true });
    return result.value ? c : null;
  }, 'the settings popup');

  const picker = await evalIn(cdpSettings, `
    document.getElementById('destination').click();
    for (let i = 0; i < 40; i++) {
      const el = document.getElementById('field-spaceId');
      if (el && el.tagName === 'SELECT') {
        return {
          tag: el.tagName,
          values: [...el.options].map(o => o.value),
          labels: [...el.options].map(o => o.textContent),
          selected: el.value,
          note: document.getElementById('note-spaceId')?.textContent ?? '',
        };
      }
      await new Promise(r => setTimeout(r, 250));
    }
    const el = document.getElementById('field-spaceId');
    return { tag: el?.tagName ?? 'MISSING', values: [], labels: [], selected: el?.value, note: document.getElementById('note-spaceId')?.textContent ?? '' };`);

  check('the space field becomes a picker on its own', picker.tag === 'SELECT', picker.tag);
  check('it lists the real spaces', picker.values.slice(0, 3).join(','), picker.values.join(','));
  check('a shared space is offered by its qualified id',
    picker.values.includes('acme:default'), picker.values.join(','));
  check('and is labelled with who shared it',
    picker.labels.some((l) => l.includes('shared by Acme')), picker.labels.find((l) => l.includes('shared')) ?? 'none');
  // The saved space is not one the account lists. It must survive anyway: it is
  // created by the first write, and losing it on open would be silent.
  check('a saved space that is not in the list survives', picker.selected === 'magpie-test', picker.selected);
  check('and is marked as not existing yet',
    picker.labels.some((l) => l === 'magpie-test — will be created'),
    picker.labels.find((l) => l.includes('magpie-test')) ?? 'none');
  check('typing a new name is still offered',
    picker.labels.some((l) => l.startsWith('Type a different name')), 'ok');

  const listed = received.filter((r) => r.url === '/v1/spaces');
  check('the listing used a bearer key on the slash-less route',
    listed.length > 0 && listed[0].headers.authorization === 'Bearer anona_live_testkey',
    `${listed.length} call(s)`);

  // ---- distill with no WebGPU -----------------------------------------
  await evalIn(cdp, `
    const s = (await chrome.storage.local.get('settings')).settings;
    await chrome.storage.local.set({ settings: { ...s, mode: 'distill' } });
    return true;`);
  const distill = await evalIn(cdp, `
    await chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE', tabId: ${tabId} });
    for (let i = 0; i < 40; i++) {
      const s = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_CAPTURE_STATE', tabId: ${tabId} });
      if (s && (s.state === 'error' || s.state === 'remembered')) return s;
      await new Promise(r => setTimeout(r, 500));
    }
    return { state: 'timeout' };`);
  check('no WebGPU is reported as such, not as a hang',
    distill?.result?.code === 'webgpu_unavailable', distill?.result?.code ?? distill?.state);
  check('and it offers raw mode as the way out', distill?.result?.recover === 'raw', distill?.result?.recover ?? 'none');

  // ---- state survives the popup ---------------------------------------
  await browser.send('Target.closeTarget', { targetId });
  await sleep(500);
  const { targetId: reopened } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const cdp2 = await waitFor(async () => {
    const t = (await http('/json/list')).find((x) => x.id === reopened);
    if (!t?.webSocketDebuggerUrl) return null;
    const c = connect(t.webSocketDebuggerUrl); await c.ready; await c.send('Runtime.enable');
    const { result } = await c.send('Runtime.evaluate', { expression: 'typeof chrome?.runtime?.id === "string"', returnByValue: true });
    return result.value ? c : null;
  }, 'the reopened popup');
  const reattached = await evalIn(cdp2, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'GET_CAPTURE_STATE', tabId: ${tabId} });`);
  check('a reopened popup reattaches to the last capture', Boolean(reattached?.state), reattached?.state ?? 'nothing');

  console.log();
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  console.log('\nNOT covered here: the distill path itself (model load, map-reduce, summary).');
  console.log('It needs WebGPU, which this Chrome build does not expose on Linux.');
  shutdown(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('\nharness error:', err.message); shutdown(2); });
