import { describe, it, expect, beforeEach } from 'vitest';
import { open, upsertPage } from '../src/db.js';
import { report, byDay } from '../src/stats.js';
import { bytes, since, uptime, sparkline, bar, width, pad, count } from '../src/ui.js';

let db;
beforeEach(() => { db = open(':memory:'); });

const days = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const page = (over = {}) => ({
  space: 'reading',
  url: 'https://example.com/a',
  title: 'A page',
  content: 'Some text about storage engines.',
  source_kind: 'page',
  captured_at: days(0),
  ...over,
});

describe('what the store says about itself', () => {
  it('counts what is in it, and what is left to embed', () => {
    upsertPage(db, page(), ['one', 'two']);
    const s = report(db);

    expect(s).toMatchObject({ pages: 1, chunks: 2, vectors: 0 });
    expect(s.characters).toBe('Some text about storage engines.'.length);
  });

  it('breaks it down by space and by what it came from', () => {
    upsertPage(db, page(), ['a']);
    upsertPage(db, page({ url: 'https://example.com/b', space: 'work', source_kind: 'pdf' }), ['b']);

    const s = report(db);
    expect(s.spaces).toEqual([
      { space: 'reading', pages: 1 },
      { space: 'work', pages: 1 },
    ]);
    expect(s.kinds.map((k) => k.kind).sort()).toEqual(['page', 'pdf']);
  });

  it('reports a fortnight with the empty days in it', () => {
    upsertPage(db, page({ captured_at: days(3) }), ['a']);
    const series = byDay(db, 14);

    expect(series).toHaveLength(14);
    expect(series.at(-1).day).toBe(new Date().toISOString().slice(0, 10));
    expect(series.filter((d) => d.n > 0)).toHaveLength(1);
    // oldest first, so it reads left to right like the chart it becomes
    expect(new Date(series[0].day) < new Date(series.at(-1).day)).toBe(true);
  });

  it('says nothing surprising about an empty store', () => {
    const s = report(db);
    expect(s).toMatchObject({ pages: 0, chunks: 0, characters: 0 });
    expect(s.newest).toBeNull();
    expect(s.spaces).toEqual([]);
    expect(s.days).toHaveLength(14);
  });
});

describe('drawing it', () => {
  it('measures what the terminal sees, not what the string holds', () => {
    // Under a pipe there is no colour at all, which is the case these run in.
    expect(width('plain')).toBe(5);
    expect(width('[1mbold[22m')).toBe(4);
    expect(pad('ab', 5)).toBe('ab   ');
  });

  it('sizes a file the way a person would say it', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(900)).toBe('900 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('separates thousands, because 12043 should not have to be counted', () => {
    expect(count(12043)).toBe('12,043');
  });

  it('says how long ago, and how long for', () => {
    expect(since(null)).toBe('never');
    expect(since(new Date(Date.now() - 30_000))).toBe('30s ago');
    expect(since(new Date(Date.now() - 7_200_000))).toBe('2h ago');
    expect(uptime(new Date(Date.now() - 90_000))).toBe('1m');
    expect(uptime(new Date(Date.now() - 3_600_000 * 26))).toBe('1d 2h');
  });

  it('draws a fortnight in a fortnight of characters', () => {
    expect(sparkline([0, 1, 2, 3]).length).toBeGreaterThanOrEqual(4);
    expect(sparkline([])).toBe('');
    // all-zero is a flat line, not a division by zero
    expect(sparkline([0, 0, 0])).toBe('▁▁▁');
  });

  it('draws a progress bar that cannot overflow its width', () => {
    expect(width(bar(0, 10, 10))).toBe(10);
    expect(width(bar(10, 10, 10))).toBe(10);
    expect(width(bar(3, 10, 10))).toBe(10);
    // nothing to do is a rule, not an empty bar that looks like no progress
    expect(width(bar(0, 0, 10))).toBe(10);
  });
});
