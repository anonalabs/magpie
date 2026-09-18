#!/usr/bin/env node
// Drives the phase-0 spike in a real Chrome over CDP, so S1 and S2 are answered
// by evidence rather than by a checklist somebody may or may not have run.
//
//   node spikes/phase0/run-spike.mjs [--headful]
//
// S4 is not scriptable: chrome.commands shortcuts cannot be dispatched by CDP
// (that is the point of them). It is checked manually per the README; this
// script at least confirms the command is registered and bound.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9333;
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'magpie-spike-'));
const chrome = spawn((process.env.CHROME_PATH ?? '/usr/bin/google-chrome'), [
  HEADFUL ? '--no-sandbox' : '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--load-extension=${resolve(HERE)}`,
  `--disable-extensions-except=${resolve(HERE)}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} rmSync(profile, { recursive: true, force: true }); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function http(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function waitForChrome() {
  for (let i = 0; i < 100; i++) {
    try { return await http('/json/version'); } catch { await sleep(200); }
  }
  throw new Error('Chrome never opened its debugging port');
}

// Minimal CDP client: one socket, id-matched replies.
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
  };
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function findExtensionId() {
  for (let i = 0; i < 60; i++) {
    const targets = await http('/json/list');
    // Chrome loads its own component extensions, which show up here first as
    // MV2 background_pages. Ours is the only MV3 service worker.
    const hit = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    if (hit) return new URL(hit.url).host;
    await sleep(500);
  }
  throw new Error('extension target never appeared — did it fail to load?');
}

async function swAlive() {
  const targets = await http('/json/list');
  return targets.some((t) => t.type === 'service_worker' && t.url.includes('background.js'));
}

async function openPopup(extId) {
  const { targetId } = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extId}/popup.html`,
  });
  let cdp;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const page = (await http('/json/list')).find((t) => t.id === targetId);
    if (!page?.webSocketDebuggerUrl) continue;
    if (!cdp) { cdp = connect(page.webSocketDebuggerUrl); await cdp.ready; await cdp.send('Runtime.enable'); }
    // The target exists before it has navigated to the extension origin, and an
    // evaluate in that window sees a page with no chrome.runtime at all.
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'typeof chrome !== "undefined" && typeof chrome.runtime?.id === "string"',
      returnByValue: true,
    });
    if (result.value === true) return { cdp, targetId };
  }
  throw new Error('popup page never gained extension API access');
}

// Runs inside the popup page, which has full extension API access.
async function evalInPopup(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? ''));
  return result.value;
}

const send = (target, msg) =>
  `return await chrome.runtime.sendMessage(${JSON.stringify({ target, ...msg })});`;

const results = [];
const record = (id, pass, detail) => {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

let browser;

async function main() {
  const version = await waitForChrome();
  console.log(`${version.Browser}\n`);
  browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  const extId = await findExtensionId();
  console.log(`extension id: ${extId}\n`);

  let { cdp, targetId } = await openPopup(extId);

  // --- setup -------------------------------------------------------------
  const ensured = await evalInPopup(cdp, send('background', { type: 'ENSURE_OFFSCREEN' }));
  if (!ensured?.ok) throw new Error(`could not create offscreen document: ${JSON.stringify(ensured)}`);

  const first = await evalInPopup(cdp, send('offscreen', { type: 'PING' }));
  console.log(`offscreen instance ${first.instanceId} created\n`);

  // --- S2: start a job, then abandon it across the worker's idle death ----
  await evalInPopup(cdp, send('offscreen', { type: 'START_JOB', jobId: 'spike-job', durationMs: Math.max(5, Number(process.env.SPIKE_WAIT_S ?? 60) - 15) * 1000 }));
  await browser.send('Target.closeTarget', { targetId });   // popup goes away
  const WAIT_S = Number(process.env.SPIKE_WAIT_S ?? 60);
  console.log(`job started, popup closed; waiting ${WAIT_S}s for the worker to idle out...`);

  let sawWorkerDie = false;
  for (let i = 0; i < WAIT_S; i++) {
    await sleep(1000);
    if (!(await swAlive())) sawWorkerDie = true;
    if (i % 15 === 14) console.log(`  ...${i + 1}s (worker alive: ${await swAlive()})`);
  }
  record('SW-IDLE', sawWorkerDie,
    sawWorkerDie ? 'service worker was observed terminated while the job ran'
                 : 'worker never died — S1/S2 below did not actually get tested');

  // --- S1 + S2: reattach -------------------------------------------------
  ({ cdp, targetId } = await openPopup(extId));
  const second = await evalInPopup(cdp, send('offscreen', { type: 'PING' }));
  record('S1', second.instanceId === first.instanceId,
    `instanceId ${first.instanceId} -> ${second.instanceId}, uptime ${Math.round(second.uptimeMs / 1000)}s`);

  const state = await evalInPopup(cdp, send('offscreen', { type: 'GET_STATE' , jobId: 'spike-job' }));
  const job = state?.job;
  record('S2', job?.state === 'done' && job.done === job.total,
    job ? `job ${job.state} ${job.done}/${job.total}` : 'job state was lost entirely');

  // --- S4: registration only (the keypress itself is manual) -------------
  const cmds = await evalInPopup(cdp, 'return await chrome.commands.getAll();');
  const cmd = cmds.find((c) => c.name === 'remember-page');
  record('S4-REGISTERED', Boolean(cmd?.shortcut),
    cmd ? `bound to "${cmd.shortcut || '(unbound)'}" — press it manually per the README to finish S4`
        : 'command not registered at all');

  cdp.close();
  browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('\nspike harness error:', err.message); process.exit(2); });
