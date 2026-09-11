import { describe, it, expect } from 'vitest';
import {
  BACKOFF_MS, MAX_ATTEMPTS, nextAttemptDelay, totalRetryWindowMs,
  isRetryable, normaliseUrl, captureKey, prune, settle, DONE_HISTORY_LIMIT,
} from '../src/lib/queue.js';

describe('backoff', () => {
  it('starts soon and grows', () => {
    expect(nextAttemptDelay(1)).toBe(30_000);
    expect(nextAttemptDelay(2)).toBe(120_000);
    expect(nextAttemptDelay(3)).toBe(600_000);
    expect(nextAttemptDelay(4)).toBe(3_600_000);
  });

  it('settles at a steady interval rather than growing forever', () => {
    const last = BACKOFF_MS.at(-1);
    for (const attempts of [5, 9, 20, MAX_ATTEMPTS - 1]) {
      expect(nextAttemptDelay(attempts), `attempt ${attempts}`).toBe(last);
    }
  });

  it('stops, so a capture does not retry silently forever', () => {
    expect(nextAttemptDelay(MAX_ATTEMPTS)).toBeNull();
    expect(nextAttemptDelay(MAX_ATTEMPTS + 50)).toBeNull();
  });

  it('keeps trying for about a week before giving up', () => {
    const days = totalRetryWindowMs() / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });
});

describe('isRetryable', () => {
  it('retries the failures that pass', () => {
    for (const result of [
      { ok: false, code: 'network', message: 'Failed to fetch' },
      { ok: false, status: 500 }, { ok: false, status: 503 }, { ok: false, status: 504 },
      { ok: false, status: 429 },
      { ok: false, status: 402 },   // out of credits; balances refill
      { ok: false, status: 599 },   // an unrecognised 5xx is still a server problem
    ]) expect(isRetryable(result), JSON.stringify(result)).toBe(true);
  });

  it('does not retry the failures that will not', () => {
    for (const result of [
      { ok: false, status: 401 },   // key rejected
      { ok: false, status: 403, code: 'space_read_only' },
      { ok: false, status: 422 },   // body refused
      { ok: false, status: 404 },
      { ok: false, code: 'not_configured' },
      { ok: false, code: 'content_too_long' },
    ]) expect(isRetryable(result), JSON.stringify(result)).toBe(false);
  });

  it('classifies by status even when the provider sends its own code', () => {
    // A provider's codes are its own vocabulary; the status is the part they
    // all agree on.
    expect(isRetryable({ ok: false, status: 503, code: 'engine_unavailable' })).toBe(true);
    expect(isRetryable({ ok: false, status: 403, code: 'space_owner_only' })).toBe(false);
  });

  it('gives an unrecognisable failure the benefit of the doubt', () => {
    expect(isRetryable(undefined)).toBe(true);
    expect(isRetryable({ ok: false })).toBe(true);
  });

  it('never retries something that worked', () => {
    expect(isRetryable({ ok: true, status: 201 })).toBe(false);
  });
});

describe('normaliseUrl', () => {
  it('treats the same article from two newsletters as one page', () => {
    expect(normaliseUrl('https://example.com/post?utm_source=a&utm_campaign=b'))
      .toBe(normaliseUrl('https://example.com/post?fbclid=xyz'));
  });

  it('ignores the fragment, the www, and a trailing slash', () => {
    const canonical = normaliseUrl('https://example.com/post');
    expect(normaliseUrl('https://www.example.com/post/#section-2')).toBe(canonical);
    expect(normaliseUrl('https://EXAMPLE.com/post')).toBe(canonical);
  });

  it('keeps parameters that choose the page, in a stable order', () => {
    // ?id=2 is a different article; ?utm_source is the same one.
    expect(normaliseUrl('https://example.com/a?id=2')).not.toBe(normaliseUrl('https://example.com/a?id=3'));
    expect(normaliseUrl('https://example.com/a?b=2&a=1')).toBe(normaliseUrl('https://example.com/a?a=1&b=2'));
  });

  it('does not throw on something that is not a url', () => {
    expect(normaliseUrl('not a url')).toBe('not a url');
    expect(normaliseUrl(undefined)).toBe('');
  });
});

describe('captureKey', () => {
  it('is the same page and the same destination', () => {
    expect(captureKey('anona', 'https://example.com/a#x')).toBe(captureKey('anona', 'https://example.com/a'));
  });

  it('separates the same page saved to different providers', () => {
    expect(captureKey('anona', 'https://example.com/a')).not.toBe(captureKey('mem0', 'https://example.com/a'));
  });
});

describe('prune', () => {
  const done = (i) => ({ id: `d${i}`, state: 'done', capturedAt: new Date(2026, 0, 1, 0, i).toISOString() });

  it('keeps the newest landed captures and drops the rest', () => {
    const records = Array.from({ length: DONE_HISTORY_LIMIT + 40 }, (_, i) => done(i));
    const kept = prune(records);
    expect(kept).toHaveLength(DONE_HISTORY_LIMIT);
    expect(kept[0].id).toBe(`d${DONE_HISTORY_LIMIT + 39}`);   // newest survives
  });

  it('never discards work that has not finished', () => {
    // Unfinished records are not history — they are things that still have to
    // happen, and pruning them would be the data loss this whole piece exists
    // to prevent.
    const records = [
      ...Array.from({ length: DONE_HISTORY_LIMIT + 50 }, (_, i) => done(i)),
      { id: 'p', state: 'pending' },
      { id: 'b', state: 'blocked' },
    ];
    const kept = prune(records);
    expect(kept.find((r) => r.id === 'p')).toBeTruthy();
    expect(kept.find((r) => r.id === 'b')).toBeTruthy();
    expect(kept.filter((r) => r.state === 'done')).toHaveLength(DONE_HISTORY_LIMIT);
  });
});

describe('settle', () => {
  const record = { id: '1', state: 'pending', attempts: 0, content: 'the summary', url: 'https://x.test/a' };

  it('drops the content once the capture has landed', () => {
    const settled = settle(record, { ok: true }, 1000);
    expect(settled.state).toBe('done');
    expect(settled).not.toHaveProperty('content');
    expect(settled.url).toBe('https://x.test/a');   // metadata stays
  });

  it('keeps the content while there is still a write to make', () => {
    const settled = settle(record, { ok: false, status: 503 }, 1000);
    expect(settled.state).toBe('pending');
    expect(settled.content).toBe('the summary');
    expect(settled.nextAttemptAt).toBe(1000 + 30_000);
    expect(settled.attempts).toBe(1);
  });

  it('blocks a terminal failure immediately, without a single retry', () => {
    const settled = settle(record, { ok: false, status: 401, message: 'key rejected' }, 1000);
    expect(settled.state).toBe('blocked');
    expect(settled.nextAttemptAt).toBeNull();
    expect(settled.lastError).toMatchObject({ message: 'key rejected' });
    expect(settled.content).toBe('the summary');    // still retryable by hand
  });

  it('blocks a retryable failure once the schedule runs out', () => {
    const settled = settle({ ...record, attempts: MAX_ATTEMPTS - 1 }, { ok: false, status: 503 }, 1000);
    expect(settled.state).toBe('blocked');
  });
});
