// Running in the background, and knowing whether it is.
//
// A pid file rather than a process manager: this is one program on one machine
// for one person, and asking someone to install systemd units to keep a reading
// list is the kind of thing that ends with them not keeping one.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PORT, HOME, ensureHome } from './config.js';

export const PID_PATH = join(HOME, 'magpie-local.pid');
export const LOG_PATH = join(HOME, 'magpie-local.log');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The running process, or null. A pid file for a dead process is cleaned up. */
export function running() {
  if (!existsSync(PID_PATH)) return null;

  const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
  if (!pid || !alive(pid)) { rmSync(PID_PATH, { force: true }); return null; }

  // The pid file is written at startup, so its own timestamp is the start time.
  let startedAt = null;
  try { startedAt = statSync(PID_PATH).mtime.toISOString(); } catch { /* fine */ }
  return { pid, startedAt };
}

/** Whether the API answers, which is a different question from whether a process exists. */
export async function healthy(port = DEFAULT_PORT, timeout = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeout) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function start({ port = DEFAULT_PORT, wait = 8000 } = {}) {
  const already = running();
  if (already && await healthy(port)) return { already: true, ...already };

  ensureHome();
  // Output goes to a file: a detached process writing to a terminal that has
  // since been closed is how a background daemon dies of EPIPE.
  const log = openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'cli.js'), 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, MAGPIE_PORT: String(port) },
  });
  child.unref();
  writeFileSync(PID_PATH, `${child.pid}\n`);

  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    const health = await healthy(port);
    if (health) return { already: false, pid: child.pid, startedAt: new Date().toISOString(), health };
    if (!alive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  return { already: false, pid: child.pid, failed: true, log: LOG_PATH };
}

export async function stop({ wait = 5000 } = {}) {
  const current = running();
  if (!current) return { wasRunning: false };

  try { process.kill(current.pid, 'SIGTERM'); } catch { /* already gone */ }

  const deadline = Date.now() + wait;
  while (Date.now() < deadline && alive(current.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // It had its chance to close the database cleanly.
  if (alive(current.pid)) { try { process.kill(current.pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(PID_PATH, { force: true });
  return { wasRunning: true, pid: current.pid };
}
