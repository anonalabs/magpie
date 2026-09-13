# Durable capture

Status: approved 2026-09-11. First of three agreed pieces; the others are
capture-time control, then PDF and YouTube extraction. Both write through this
one, which is why it is first.

## The problem

A capture exists only in memory until the write succeeds. If the provider is
unreachable, the key has expired, or the org is out of credits, the summary is
discarded and the work is gone.

For a tool whose only job is to remember things, that is the worst available
failure, and it is silent: nothing is lost visibly, you find out weeks later
when you search for something that was never stored.

## The change

**Persist before sending.** The summary hits disk the moment it exists. The
network write becomes a separate, retryable step against a record that already
survives a crash, a restart, and a closed browser.

## Data model

One record per capture, in `chrome.storage.local` under `captures`:

```js
{
  id,             // crypto.randomUUID()
  key,            // `${providerId}:${url}`, the duplicate-detection key
  url, title,
  capturedAt,     // ISO
  providerId,
  destination,    // human label, e.g. "Anona Memory · reading"
  mode,           // 'distill' | 'raw'
  state,          // 'pending' | 'done' | 'blocked'
  attempts,
  nextAttemptAt,  // epoch ms; null when not scheduled
  lastError,      // { code, message } or null
  content,        // the text to send, PRESENT ONLY while pending or blocked
}
```

`content` is dropped the moment a record reaches `done`. A landed capture keeps
only its metadata, so magpie can answer "have I already saved this?" without
accumulating a second copy of everything you have ever read.

Records are pruned to the most recent 200 `done` entries. `pending` and
`blocked` are never pruned: they are unfinished work, not history.

## One sender

Today the write happens in the offscreen document for distill mode and in the
service worker for raw, because the worker is long dead by the time a multi-chunk
distill finishes. The queue collapses that split: **both paths enqueue, and a
single drain loop in the worker sends.**

The offscreen document goes back to producing summaries and nothing else. It
cannot reach `chrome.storage`, so it messages the worker, which wakes it, and
holds the record in memory until the worker acknowledges the write. If the
acknowledgement never comes it retries the enqueue a few times rather than
dropping the summary on the floor.

```
capture ─▶ produce content ─▶ ENQUEUE ─▶ worker persists (pending) ─▶ drain
                                                                       │
                                              ┌── sent ────────────────┤
                                              │                        │
                                      done, content dropped     retryable ─▶ alarm
                                                                       │
                                                              terminal ─▶ blocked
```

## Retry policy

Backoff: **30s, 2m, 10m, 1h, 6h, then every 6h**, scheduled with
`chrome.alarms` so it survives the service worker being killed, a timer in the
worker would not. After roughly seven days the record becomes `blocked` and
stops on its own; a capture retrying silently for a month is noise, not
durability. A blocked record is still retryable by hand.

The split that matters, because retrying the wrong failure is worse than not
retrying at all:

| Retryable | Terminal, straight to `blocked` |
|---|---|
| network error, timeout | 401 or 403: key rejected, or no access to the space |
| 5xx | 422 |
| 429, and 402 (credits refill) | `content_too_long`, `not_configured` |

Hammering a rejected key for a week earns a rate limit and fixes nothing. A
blocked record names what is wrong and what to do about it.

## History

A third view in the popup, reached from the header, in three groups:

- **Needs you**: blocked records, with the reason and a retry.
- **Pending**: queued, with when the next attempt is due.
- **Recent**: landed, newest first.

Every row offers retry, delete, and open the original page.

Revisiting a page already captured shows "remembered N days ago" on the idle
screen. It informs; it does not block. Re-remembering a page that has changed is
legitimate, and Supermemory already updates in place via `customId`.

## Files

| File | Change |
|---|---|
| `src/lib/queue.js` | **new**, pure: backoff schedule, retryable-vs-terminal classification, dedupe key, pruning. The tested core. |
| `src/lib/captures.js` | **new**: the `chrome.storage.local` layer, read, upsert, prune. |
| `src/background.js` | enqueue handler, drain loop, `chrome.alarms` wiring. |
| `src/offscreen.js` | stops writing to providers; enqueues instead. |
| `src/popup.{html,js,css}` | history view, duplicate notice on idle. |
| `src/lib/messages.js` | `ENQUEUE`, `LIST_CAPTURES`, `RETRY_CAPTURE`, `DELETE_CAPTURE`. |

## Testing

Unit, on the pure parts:

- the backoff schedule, including that it stops rather than growing forever;
- every status and error code lands on the correct side of retryable/terminal;
- the dedupe key, and pruning that never discards unfinished work.

End to end, on what actually matters:

- provider returns 500 → the record persists as `pending` with its content, is
  retried, and lands when the provider returns 201, and then its content is gone;
- provider returns 401 → `blocked` immediately, and never retried;
- a capture survives the service worker being killed between enqueue and send.

## Out of scope

Notes, tags and editing before save (piece 3). PDFs and YouTube (piece 2).
Reading memories back from a provider: magpie still only writes.
