// The store behind the queue: chrome.storage.local, one array under `captures`.
//
// Every mutation is a read-modify-write, and two of them interleaving would lose
// one of the writes — which is precisely the failure this whole piece exists to
// prevent. So they are serialised through one chain.

import { prune, captureKey } from './queue.js';

const KEY = 'captures';

let chain = Promise.resolve();

/** Runs `mutate` against the current records, serialised against every other. */
function mutate(mutate_) {
  const run = chain.then(async () => {
    const records = await readAll();
    const next = await mutate_(records);
    if (next) await chrome.storage.local.set({ [KEY]: prune(next) });
    return next;
  });
  chain = run.then(() => {}, () => {});
  return run;
}

export async function readAll() {
  return (await chrome.storage.local.get(KEY))[KEY] ?? [];
}

/**
 * Adds a capture, or replaces the unfinished one for the same page. Re-capturing
 * while an earlier attempt is still queued should leave one record holding the
 * newer content, not two racing to write the same page twice.
 */
export function enqueue(record) {
  const full = {
    id: crypto.randomUUID(),
    state: 'pending',
    attempts: 0,
    nextAttemptAt: Date.now(),
    lastError: null,
    ...record,
    key: captureKey(record.providerId, record.url),
  };

  return mutate((records) => {
    const withoutUnfinished = records.filter((r) => !(r.key === full.key && r.state !== 'done'));
    return [full, ...withoutUnfinished];
  }).then(() => full);
}

export function update(id, patch) {
  return mutate((records) => records.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

export function replace(record) {
  return mutate((records) => records.map((r) => (r.id === record.id ? record : r)));
}

export function remove(id) {
  return mutate((records) => records.filter((r) => r.id !== id));
}

/** Records whose next attempt is due. Blocked ones are never due on their own. */
export async function due(now = Date.now()) {
  return (await readAll()).filter((r) => r.state === 'pending' && (r.nextAttemptAt ?? 0) <= now);
}

/** The soonest future attempt, for scheduling one alarm rather than many. */
export async function nextDueAt(now = Date.now()) {
  const times = (await readAll())
    .filter((r) => r.state === 'pending' && (r.nextAttemptAt ?? 0) > now)
    .map((r) => r.nextAttemptAt);
  return times.length ? Math.min(...times) : null;
}

/** The most recent landed capture of this page, for the "already remembered" notice. */
export async function findLanded(providerId, url) {
  const key = captureKey(providerId, url);
  return (await readAll()).find((r) => r.key === key && r.state === 'done') ?? null;
}
