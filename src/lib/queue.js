// The rules a queued capture follows: when to try again, when to stop, what
// counts as the same page, and what to keep.
//
// Pure, no storage, no chrome, no clock beyond what is passed in. This is the
// part of durability that can be tested, so everything that can live here does.

/**
 * 30s, 2m, 10m, 1h, 6h, then every 6h. Short enough that a dropped connection
 * resolves itself while you are still reading, long enough that a provider
 * having a bad afternoon is not hammered.
 */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

/** ~7 days of trying. Past that it is not a transient failure any more. */
export const MAX_ATTEMPTS = 32;

/**
 * How long to wait before attempt number `attempts + 1`, or null to stop.
 * Stopping is a feature: a capture retrying silently for a month is noise, not
 * durability, and a blocked record can still be retried by hand.
 */
export function nextAttemptDelay(attempts) {
  if (attempts >= MAX_ATTEMPTS) return null;
  return BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)];
}

/** Total time the schedule covers, for documenting what "gives up" means. */
export function totalRetryWindowMs(maxAttempts = MAX_ATTEMPTS) {
  let total = 0;
  for (let i = 1; i <= maxAttempts; i++) total += nextAttemptDelay(i - 1) ?? 0;
  return total;
}

// Our own refusals. Neither improves by being repeated.
const TERMINAL_CODES = new Set(['not_configured', 'content_too_long']);

// A rejected key, a space you cannot write to, a body the API will not accept.
// Retrying these earns a rate limit and fixes nothing.
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

// Out of credits (402) is in here on purpose: balances refill, so it is worth
// carrying the capture until they do.
const RETRYABLE_STATUSES = new Set([402, 408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Whether a failed push is worth trying again.
 *
 * Classified by HTTP status first, because a provider's own error codes are its
 * own vocabulary and the status is the part every provider agrees on.
 */
export function isRetryable(result) {
  if (!result) return true;                        // no answer at all: try again
  if (result.ok) return false;
  if (TERMINAL_CODES.has(result.code)) return false;
  if (result.code === 'network') return true;      // offline, DNS, TLS

  const status = result.status;
  if (typeof status !== 'number') return true;     // an unrecognised failure gets the benefit of the doubt
  if (TERMINAL_STATUSES.has(status)) return false;
  if (RETRYABLE_STATUSES.has(status)) return true;
  return status >= 500;                            // other 5xx yes, other 4xx no
}

// Params that identify a click, not a page. Two links to the same article from
// two newsletters are the same article.
const TRACKING = /^(utm_|ref_|mc_|_hs|hsa_)|^(fbclid|gclid|gbraid|wbraid|msclkid|igshid|mkt_tok|ref|source)$/i;

/**
 * A stable identity for a page, so the same article is recognised across the
 * fragment, the tracking parameters and the trailing slash.
 */
export function normaliseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return String(raw ?? '').trim(); }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING.test(name)) url.searchParams.delete(name);
  }
  // Sorted, so ?a=1&b=2 and ?b=2&a=1 are one page.
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);

  return url.toString();
}

/** Same page, same destination. A page saved to two spaces is two captures. */
export const captureKey = (providerId, url) => `${providerId}:${normaliseUrl(url)}`;

export const DONE_HISTORY_LIMIT = 200;

/**
 * Trims landed history while never discarding unfinished work. Pending and
 * blocked records are not history: they are things that still have to happen.
 */
export function prune(records, limit = DONE_HISTORY_LIMIT) {
  const unfinished = records.filter((r) => r.state !== 'done');
  const done = records
    .filter((r) => r.state === 'done')
    .sort((a, b) => (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''))
    .slice(0, limit);
  return [...unfinished, ...done];
}

/**
 * A landed capture keeps its metadata and loses its content. That is the whole
 * privacy position: magpie can tell you it already saved this page without
 * keeping a second copy of everything you have read.
 */
export function settle(record, result, now = Date.now()) {
  if (result?.ok) {
    // Both of them: `sourceText` is a whole article, and keeping it after the
    // write is the same mistake as keeping the content, several times larger.
    const { content, sourceText, ...rest } = record;
    return { ...rest, state: 'done', lastError: null, nextAttemptAt: null, settledAt: now };
  }

  const attempts = (record.attempts ?? 0) + 1;
  const delay = isRetryable(result) ? nextAttemptDelay(attempts) : null;
  const error = { code: result?.code ?? 'unknown', message: result?.message ?? 'The write failed.' };

  return delay === null
    ? { ...record, state: 'blocked', attempts, nextAttemptAt: null, lastError: error }
    : { ...record, state: 'pending', attempts, nextAttemptAt: now + delay, lastError: error };
}
