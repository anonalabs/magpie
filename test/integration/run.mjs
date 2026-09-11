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
import { makePdf } from './make-pdf.mjs';

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

// Set by the durability tests to make the provider fail on demand.
let failWith = null;

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
      if (failWith) {
        res.writeHead(failWith, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'test_failure', message: `forced ${failWith}` } }));
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job_test_1', status: 'processing' }));
    });
  },
).listen(PORT_API);

const PDFS = { '/short.pdf': makePdf(3), '/long.pdf': makePdf(45) };

const web = createServer((req, res) => {
  if (PDFS[req.url]) {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    return res.end(PDFS[req.url]);
  }
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
  check('the receipt names where it went, space included',
    raw?.result?.providerLabel === 'Anona Memory · magpie-test',
    String(raw?.result?.providerLabel));

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

  // ---- a one-off mode must not become the setting -------------------------
  // "Send the page text instead" is offered from an error dialog. Sending raw is
  // ~270x the content at the provider and is billed on it, so a click there must
  // not move every future capture onto that path.
  await evalIn(cdp, `
    const s = (await chrome.storage.local.get('settings')).settings;
    await chrome.storage.local.set({ settings: { ...s, mode: 'distill' } });
    return true;`);

  const beforeOneOff = received.filter((r) => r.url === '/v1/record').length;
  const oneOff = await evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE', tabId: ${tabId}, mode: 'raw' });`);
  const modeAfter = await evalIn(cdp, `
    return (await chrome.storage.local.get('settings')).settings.mode;`);
  const oneOffBody = received.filter((r) => r.url === '/v1/record').at(-1)?.body;

  check('a one-off raw capture really sends the article text',
    received.filter((r) => r.url === '/v1/record').length > beforeOneOff && oneOffBody?.content?.length > 1000,
    `${oneOffBody?.content?.length ?? 0} chars, state ${oneOff?.state}`);
  check('and the saved mode is untouched', modeAfter === 'distill', modeAfter);
  check('the capture records the mode it actually used', oneOffBody?.metadata?.mode === 'raw', oneOffBody?.metadata?.mode);

  // Back to raw for the sections below: they exercise the queue, and distilling
  // needs a WebGPU device this Chrome does not have.
  await evalIn(cdp, `
    const s = (await chrome.storage.local.get('settings')).settings;
    await chrome.storage.local.set({ settings: { ...s, mode: 'raw' } });
    return true;`);

  // ---- durability: a failed write is kept, not lost ----------------------
  const capture = async () => evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE', tabId: ${tabId} });`);
  const records = async () => evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'LIST_CAPTURES' });`);

  failWith = 503;
  const queuedCapture = await capture();
  check('a provider outage does not report success', queuedCapture?.state === 'queued', queuedCapture?.state);

  let kept = (await records()).find((r) => r.url.startsWith('http://127.0.0.1'));
  check('the capture is on disk, not lost', Boolean(kept), kept ? kept.state : 'no record');
  check('and it kept the content it still has to send',
    typeof kept?.content === 'string' && kept.content.length > 1000, `${kept?.content?.length ?? 0} chars`);
  check('with a retry scheduled', kept?.state === 'pending' && kept?.attempts === 1 && kept?.nextAttemptAt > Date.now(),
    `${kept?.state}, attempt ${kept?.attempts}`);

  // Now the provider recovers.
  failWith = null;
  await evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'RETRY_CAPTURE', id: ${JSON.stringify(kept?.id)} });`);

  kept = (await records()).find((r) => r.id === kept.id);
  check('a retry lands it once the provider is back', kept?.state === 'done', kept?.state);
  check('and the content is dropped once it has landed',
    kept?.content === undefined, kept?.content === undefined ? 'dropped' : 'still stored');

  // ---- durability: a terminal failure stops ------------------------------
  failWith = 401;
  const before401 = received.filter((r) => r.url === '/v1/record').length;
  const rejected = await capture();
  const after401 = received.filter((r) => r.url === '/v1/record').length;

  const blocked = (await records()).find((r) => r.state === 'blocked');
  check('a rejected key blocks instead of queueing', Boolean(blocked), rejected?.state ?? 'none');
  check('and is not retried even once', after401 - before401 === 1, `${after401 - before401} request(s)`);
  check('the reason is kept so it can be acted on', Boolean(blocked?.lastError?.message), blocked?.lastError?.message);

  // Clean up so later sections see a normal provider.
  failWith = null;
  await evalIn(cdp, `
    const rs = await chrome.runtime.sendMessage({ target: 'background', type: 'LIST_CAPTURES' });
    for (const r of rs) await chrome.runtime.sendMessage({ target: 'background', type: 'DELETE_CAPTURE', id: r.id });
    return true;`);

  // ---- compose: a note joins the content ----------------------------------
  const started = await evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'START_COMPOSE', tabId: ${tabId} });`);
  check('compose reads the page and is ready straight away in raw mode',
    started?.ok === true && started?.ready === true && started.body.length > 1000,
    `${started?.body?.length ?? 0} chars`);

  const composedBefore = received.filter((r) => r.url === '/v1/record').length;
  await evalIn(cdp, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'SAVE_COMPOSE', draft: {
      tabId: ${tabId}, title: ${JSON.stringify('The Test Article')}, url: ${JSON.stringify(`http://127.0.0.1:${PORT_WEB}/`)},
      mode: 'raw', note: 'for the caching rewrite', content: 'The body that was captured.',
    }});`);

  const composed = received.filter((r) => r.url === '/v1/record').at(-1)?.body;
  check('a compose capture reached the provider',
    received.filter((r) => r.url === '/v1/record').length > composedBefore, 'sent');
  check('the note is inside the content, where it can be found',
    composed?.content?.startsWith('for the caching rewrite'), JSON.stringify(composed?.content?.slice(0, 40)));
  check('and the body follows it after a separator',
    composed?.content?.includes('\n\n---\n\n') && composed?.content?.endsWith('The body that was captured.'),
    'joined');
  check('the note is mirrored in metadata, never only there',
    composed?.metadata?.note === 'for the caching rewrite', composed?.metadata?.note);

  // ---- selection: the full selection, not Chrome's truncated copy ----------
  // context-menu clicks cannot be dispatched, so this tests the mechanism the
  // handler uses: reading the live selection instead of info.selectionText,
  // which Chrome truncates.
  const selectionLength = await evalIn(cdp, `
    const [{ result: selected }] = await chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      func: () => {
        const article = document.querySelector('article');
        const range = document.createRange();
        range.selectNodeContents(article);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return (window.getSelection()?.toString() ?? '').length;
      },
    });
    return selected;`);

  // Chrome caps info.selectionText well under this; reading the live selection
  // is what makes a long quote arrive whole.
  check('a long selection is read whole, past Chrome\'s truncation limit',
    selectionLength > 5000, `${selectionLength} chars`);

  // ---- PDFs ---------------------------------------------------------------
  // Chrome renders these in a viewer no content script can enter, so this path
  // fetches and parses the file instead. Raw mode, because parsing is what is
  // under test and distilling would need a GPU this Chrome does not have.
  const capturePdf = async (path) => {
    const { targetId: pdfTarget } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT_WEB}${path}` });
    await sleep(1500);
    const pdfTabId = await evalIn(cdp, `
      const tabs = await chrome.tabs.query({});
      return tabs.find(t => (t.url ?? '').endsWith(${JSON.stringify(path)}))?.id ?? null;`);
    if (pdfTabId == null) return { job: null, tabId: null };
    const job = await evalIn(cdp, `
      await chrome.runtime.sendMessage({ target: 'background', type: 'START_CAPTURE', tabId: ${pdfTabId} });
      let last = null;
      for (let i = 0; i < 60; i++) {
        last = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_CAPTURE_STATE', tabId: ${pdfTabId} });
        if (last && ['remembered', 'queued', 'error'].includes(last.state)) return last;
        await new Promise(r => setTimeout(r, 500));
      }
      // Saying what it was actually stuck on beats saying "timeout".
      return { state: 'timeout', stuckAt: last?.state ?? 'nothing', stage: last?.stage ?? '' };`);
    await browser.send('Target.closeTarget', { targetId: pdfTarget }).catch(() => {});
    return { job, tabId: pdfTabId };
  };

  const shortPdf = await capturePdf('/short.pdf');
  check('a PDF tab captures instead of reporting an unreadable page',
    shortPdf.job?.state === 'remembered',
    `${shortPdf.job?.state}${shortPdf.job?.stuckAt ? ` (stuck at ${shortPdf.job.stuckAt}: ${shortPdf.job.stage})` : ''} ${shortPdf.job?.result?.message ?? ''}`);

  const shortBody = received.filter((r) => r.url === '/v1/record').at(-1)?.body;
  check('the text inside the PDF arrives',
    shortBody?.content?.includes('marker-1-end') && shortBody?.content?.includes('marker-3-end'),
    `${shortBody?.content?.length ?? 0} chars`);
  check('a short PDF carries no truncation notice',
    !shortBody?.content?.includes('Summarised from the first'), 'none');
  check('and is marked as a pdf', shortBody?.metadata?.source_kind === 'pdf', shortBody?.metadata?.source_kind);

  const longPdf = await capturePdf('/long.pdf');
  const longBody = received.filter((r) => r.url === '/v1/record').at(-1)?.body;
  check('a long PDF is capped', longPdf.job?.state === 'remembered', longPdf.job?.state);
  check('and says so in the content, where recall will see it',
    longBody?.content?.includes('(Summarised from the first 40 of 45 pages.)'),
    longBody?.content?.slice(-60));
  check('the pages it read are recorded too',
    longBody?.metadata?.pages_read === 40 && longBody?.metadata?.pages_total === 45,
    `${longBody?.metadata?.pages_read}/${longBody?.metadata?.pages_total}`);
  check('and nothing past the cap was read',
    longBody?.content?.includes('marker-40-end') && !longBody?.content?.includes('marker-41-end'), 'capped');

  // ---- a shapeless failure must still say what went wrong -----------------
  // Anything thrown in the worker comes back as {ok:false, code, message} with
  // no `state`. The popup rendered that as a bare "Something went wrong" while
  // holding the reason, which is how three rounds of a real bug went undiagnosed.
  const shapeless = await evalIn(cdp, `
    // A tab id that does not exist: the worker throws rather than returning a job.
    const answer = await chrome.runtime.sendMessage({
      target: 'background', type: 'START_CAPTURE', tabId: 999999 });
    return answer;`);

  check('a thrown failure carries a message, not just a shape',
    Boolean(shapeless?.result?.message ?? shapeless?.message), JSON.stringify(shapeless).slice(0, 120));
  check('and names a code that can be reported',
    Boolean(shapeless?.result?.code ?? shapeless?.code), shapeless?.result?.code ?? shapeless?.code ?? 'none');


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

  // ---- getting back out of settings -------------------------------------
  // The settings view is taller than the popup, so it scrolls. The way home
  // must not scroll away with it.
  const exits = await evalIn(cdpSettings, `
    // Make sure we are in settings, however the earlier step left things.
    if (document.getElementById('view-settings').hidden) document.getElementById('destination').click();
    const open = !document.getElementById('view-settings').hidden;
    const bar = getComputedStyle(document.querySelector('.topbar'));
    const viaHeader = document.getElementById('destination');
    const viaBottom = document.getElementById('close-settings');
    viaBottom.click();
    const home = document.getElementById('view-main').hidden === false;
    viaHeader.click();
    const backIn = document.getElementById('view-settings').hidden === false;
    const label = document.getElementById('destination-text').textContent;
    viaHeader.click();
    return { open, sticky: bar.position, home, backIn, label,
             homeAgain: document.getElementById('view-main').hidden === false };`);

  check('settings was open to begin with', exits.open === true, String(exits.open));
  check('the top bar is pinned, so the way back never scrolls off', exits.sticky === 'sticky', exits.sticky);
  check('the bottom Back button returns home', exits.home === true, String(exits.home));
  check('the header control toggles both ways', exits.backIn && exits.homeAgain, `in ${exits.backIn}, out ${exits.homeAgain}`);
  check('and it says Back while settings is open', exits.label === 'Back', exits.label);

  // ---- the in-page button ----------------------------------------------
  // The optional all-sites grant needs a native Chrome dialog that cannot be
  // driven from here, so the permission is stood in for by registering the
  // script the same way syncInPage() does. What is under test is the button.
  await evalIn(cdpSettings, `
    await chrome.scripting.registerContentScripts([{
      id: 'magpie-in-page', js: ['in-page.js'],
      matches: ['http://127.0.0.1:${PORT_WEB}/*'], runAt: 'document_idle', allFrames: false,
    }]);
    return true;`);

  const { targetId: pageTab } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT_WEB}/` });
  const cdpPage = await waitFor(async () => {
    const t = (await http('/json/list')).find((x) => x.id === pageTab);
    if (!t?.webSocketDebuggerUrl) return null;
    const c = connect(t.webSocketDebuggerUrl); await c.ready; await c.send('Runtime.enable');
    return c;
  }, 'the page tab');

  const mounted = await waitFor(async () => {
    const { result } = await cdpPage.send('Runtime.evaluate', {
      expression: `(() => { const h = document.getElementById('magpie-in-page-root');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                 position: getComputedStyle(h).position, z: getComputedStyle(h).zIndex };
      })()`,
      returnByValue: true,
    });
    return result.value;
  }, 'the in-page button to mount', 30).catch(() => null);

  check('the in-page button mounts on a real page', Boolean(mounted),
    mounted ? `${mounted.w}x${mounted.h} at ${mounted.x},${mounted.y}` : 'never appeared');

  if (mounted) {
    check('it is fixed and above the page', mounted.position === 'fixed' && Number(mounted.z) > 1000000,
      `${mounted.position} z=${mounted.z}`);
    check('it is a dot at rest, not a bar', mounted.w < 70 && mounted.h > 20 && mounted.h < 60,
      `${mounted.w}x${mounted.h}`);

    // The shadow root is closed on purpose, so this asserts behaviour rather
    // than internals: a real click at its centre must start a capture.
    const writesBefore = received.filter((r) => r.url === '/v1/record').length;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdpPage.send('Input.dispatchMouseEvent', {
        type, x: mounted.x, y: mounted.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
    }

    const captured = await waitFor(async () => {
      const after = received.filter((r) => r.url === '/v1/record').length;
      return after > writesBefore ? after - writesBefore : null;
    }, 'a capture started from the page button', 40).catch(() => 0);

    check('clicking it remembers the page', captured > 0,
      captured ? `${captured} write(s) reached the provider` : 'no write ever arrived');
  }

  // ---- appearing on a tab that was already open ---------------------------
  // What injectIntoOpenTabs does after the permission is granted. Without it the
  // button reaches nothing already open, including the tab the reader is on.
  // Clear the registration left by the previous section, so this tab genuinely
  // opens with no content script and "before" means before.
  await evalIn(cdpSettings, `
    await chrome.scripting.unregisterContentScripts({ ids: ['magpie-in-page'] }).catch(() => {});
    return true;`);

  const { targetId: openTab } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT_WEB}/` });
  const cdpOpen = await waitFor(async () => {
    const t = (await http('/json/list')).find((x) => x.id === openTab);
    if (!t?.webSocketDebuggerUrl) return null;
    const c = connect(t.webSocketDebuggerUrl); await c.ready; await c.send('Runtime.enable');
    return c;
  }, 'an already-open tab');

  const openTabId = await evalIn(cdpSettings, `
    const tabs = await chrome.tabs.query({});
    return tabs.filter(t => (t.url ?? '').startsWith('http://127.0.0.1:${PORT_WEB}/')).pop()?.id ?? null;`);

  const beforeInject = await evalIn(cdpOpen, "return Boolean(document.getElementById('magpie-in-page-root'));");
  check('a tab open before the grant has no button', beforeInject === false, String(beforeInject));

  await evalIn(cdpSettings, `
    await chrome.scripting.executeScript({ target: { tabId: ${openTabId} }, files: ['in-page.js'] });
    return true;`);

  const afterInject = await waitFor(async () => {
    const { result } = await cdpOpen.send('Runtime.evaluate', {
      expression: "Boolean(document.getElementById('magpie-in-page-root'))", returnByValue: true,
    });
    return result.value ? true : null;
  }, 'the injected button', 20).catch(() => false);

  check('injecting reaches it without a page reload', afterInject === true, String(afterInject));

  // Injecting twice must not stack two buttons on one page.
  await evalIn(cdpSettings, `
    await chrome.scripting.executeScript({ target: { tabId: ${openTabId} }, files: ['in-page.js'] });
    return true;`);
  await sleep(600);
  const count = await evalIn(cdpOpen, "return document.querySelectorAll('#magpie-in-page-root').length;");
  check('and injecting again does not stack a second one', count === 1, `${count} button(s)`);

  // ---- the status the settings panel reports ------------------------------
  // Without the optional grant, the honest answer is "not granted, not
  // installed" — and never a cheerful success.
  const status = await evalIn(cdpSettings, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'IN_PAGE_STATUS' });`);
  check('status reports the permission truthfully', status?.granted === false, JSON.stringify(status));

  const failedSync = await evalIn(cdpSettings, `
    return await chrome.runtime.sendMessage({ target: 'background', type: 'SYNC_IN_PAGE' });`);
  check('a sync without permission reports not-registered, not success',
    failedSync?.granted === false && failedSync?.registered === false && failedSync?.error === null,
    JSON.stringify(failedSync));

  // ---- a stale content-script registration --------------------------------
  // Registrations persist across sessions, so one made by a previous version
  // survives an update carrying that version's match patterns. syncInPage must
  // clear it rather than read it as "already registered".
  const stale = await evalIn(cdpSettings, `
    await chrome.scripting.unregisterContentScripts({ ids: ['magpie-in-page'] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{
      id: 'magpie-in-page', js: ['in-page.js'],
      matches: ['http://127.0.0.1:${PORT_WEB}/*'], runAt: 'document_idle',
    }]);
    const before = (await chrome.scripting.getRegisteredContentScripts({ ids: ['magpie-in-page'] })).length;
    await chrome.runtime.sendMessage({ target: 'background', type: 'SYNC_IN_PAGE' });
    const after = (await chrome.scripting.getRegisteredContentScripts({ ids: ['magpie-in-page'] })).length;
    return { before, after };`);

  // The all-sites permission is not granted here, so the correct end state is
  // no registration at all — and crucially not the stale one.
  check('a stale registration is cleared, not trusted', stale.before === 1 && stale.after === 0,
    `before ${stale.before}, after ${stale.after}`);

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
