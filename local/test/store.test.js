import { describe, it, expect, beforeEach } from 'vitest';
import {
  open, upsertPage, deletePage, getPage, getPageByUrl, recentPages, spaces, stats,
  putVector, allVectors, chunksNeedingVectors, hydrate, toBlob, fromBlob,
} from '../src/db.js';
import { ftsQuery, ftsSearch, vectorSearch, rrf, search } from '../src/search.js';
import { record } from '../src/http.js';

let db;
beforeEach(() => { db = open(':memory:'); });

const page = (over = {}) => ({
  space: 'default',
  url: 'https://example.com/ddia/ch3',
  title: 'Storage and Retrieval',
  content: 'LSM trees write sequentially and compact in the background. B-trees update pages in place.',
  source_kind: 'page',
  captured_at: '2026-09-15T10:00:00.000Z',
  ...over,
});

describe('the store', () => {
  it('keeps a page and its chunks together', () => {
    const { id, chunkIds } = upsertPage(db, page(), ['one chunk', 'two chunk']);
    expect(getPage(db, id).title).toBe('Storage and Retrieval');
    expect(chunkIds).toHaveLength(2);
    expect(stats(db)).toMatchObject({ pages: 1, chunks: 2 });
  });

  it('replaces a page captured again, rather than storing it twice', () => {
    upsertPage(db, page(), ['first version']);
    upsertPage(db, page({ title: 'Storage and Retrieval, revised' }), ['second version']);

    expect(stats(db)).toMatchObject({ pages: 1, chunks: 1 });
    expect(getPageByUrl(db, 'default', 'https://example.com/ddia/ch3').title)
      .toBe('Storage and Retrieval, revised');
    // and the previous version's sentences are not left behind to be found
    // later. The word has to be one only the old chunk had: search is OR, so
    // "version" alone still matches the chunk that replaced it.
    expect(ftsSearch(db, 'first')).toHaveLength(0);
    expect(ftsSearch(db, 'second')).toHaveLength(1);
  });

  it('treats the same URL in another space as another memory', () => {
    upsertPage(db, page(), ['a']);
    upsertPage(db, page({ space: 'work' }), ['a']);
    expect(stats(db).pages).toBe(2);
    expect(spaces(db).map((s) => s.space_id)).toEqual(['default', 'work']);
  });

  it('deleting a page takes its chunks, its index and its vectors with it', () => {
    const { id, chunkIds } = upsertPage(db, page(), ['compaction happens in the background']);
    putVector(db, chunkIds[0], new Array(384).fill(0.1));

    deletePage(db, id);

    expect(stats(db)).toMatchObject({ pages: 0, chunks: 0, vectors: 0 });
    expect(ftsSearch(db, 'compaction')).toHaveLength(0);
  });

  it('lists what was saved most recently first', () => {
    upsertPage(db, page({ url: 'https://example.com/a', captured_at: '2026-09-01T00:00:00Z' }), ['a']);
    upsertPage(db, page({ url: 'https://example.com/b', captured_at: '2026-09-14T00:00:00Z' }), ['b']);
    expect(recentPages(db, { limit: 2 }).map((p) => p.url))
      .toEqual(['https://example.com/b', 'https://example.com/a']);
  });
});

describe('vectors', () => {
  it('survives the trip through a blob', () => {
    const vector = [0.5, -0.25, 0.125];
    expect(Array.from(fromBlob(toBlob(vector)))).toEqual(vector);
  });

  it('is only read back for the model that wrote it', () => {
    const { chunkIds } = upsertPage(db, page(), ['one']);
    putVector(db, chunkIds[0], new Array(4).fill(0.5), 'old-model');

    // A vector from another model is not compared against; comparing across
    // models does not fail, it quietly returns nonsense.
    expect(allVectors(db, { model: 'current-model' })).toHaveLength(0);
    expect(allVectors(db, { model: 'old-model' })).toHaveLength(1);
  });

  it('offers a chunk whose vector belongs to another model as work to do', () => {
    const { chunkIds } = upsertPage(db, page(), ['one']);
    putVector(db, chunkIds[0], new Array(4).fill(0.5), 'old-model');

    const pending = chunksNeedingVectors(db, { model: 'current-model' });
    expect(pending.map((row) => row.id)).toEqual(chunkIds);
    expect(chunksNeedingVectors(db, { model: 'old-model' })).toHaveLength(0);
  });
});

describe('the query a reader types is not a query language', () => {
  it('quotes each word, so FTS5 operators are matched as words', () => {
    expect(ftsQuery('compaction AND merge')).toBe('"compaction" OR "AND" OR "merge"');
    expect(ftsQuery('what about NEAR/2 things?')).toBe('"what" OR "about" OR "NEAR" OR "things"');
  });

  it('survives a quote, which would otherwise end the phrase early', () => {
    expect(ftsQuery('the "big" one')).toBe('"the" OR "big" OR "one"');
  });

  it('comes back empty rather than matching everything', () => {
    expect(ftsQuery('')).toBe('');
    expect(ftsQuery('  ?? !  ')).toBe('');
    expect(ftsSearch(db, '')).toEqual([]);
  });
});

describe('fusing two rankings', () => {
  it('puts what both retrievers found above what only one did', () => {
    const keyword = [{ chunkId: 1, rank: 1 }, { chunkId: 2, rank: 2 }];
    const semantic = [{ chunkId: 3, rank: 1 }, { chunkId: 2, rank: 2 }];
    expect(rrf([keyword, semantic]).map((r) => r.chunkId)).toEqual([2, 1, 3]);
  });

  it('is stable when scores tie', () => {
    const a = [{ chunkId: 9, rank: 1 }];
    const b = [{ chunkId: 4, rank: 1 }];
    expect(rrf([a, b]).map((r) => r.chunkId)).toEqual([4, 9]);
  });

  it('is just the one list when there is only one', () => {
    expect(rrf([[{ chunkId: 7, rank: 1 }, { chunkId: 8, rank: 2 }]]).map((r) => r.chunkId))
      .toEqual([7, 8]);
  });
});

describe('searching', () => {
  beforeEach(() => {
    upsertPage(db, page(), [
      'LSM trees write sequentially and compact in the background.',
      'B-trees update pages in place, giving predictable read latency.',
    ]);
    upsertPage(db, page({ url: 'https://example.com/other', title: 'Something else', space: 'work' }),
      ['A note about invoices and billing periods.']);
  });

  it('finds a page by a word in its body', async () => {
    const results = await search(db, 'compaction background');
    expect(results[0].title).toBe('Storage and Retrieval');
    expect(results[0].matched).toEqual(['keyword']);
    expect(results[0].snippet).toContain('[');
  });

  it('stays inside a space when asked to', async () => {
    expect(await search(db, 'invoices', { space: 'default' })).toHaveLength(0);
    expect(await search(db, 'invoices', { space: 'work' })).toHaveLength(1);
  });

  it('uses the model when there is one, and says which retriever matched', async () => {
    const { chunkIds } = upsertPage(db, page({ url: 'https://example.com/vec' }), ['a chunk with a vector']);
    putVector(db, chunkIds[0], [1, 0, 0, 0]);

    const results = await search(db, 'anything at all', { embed: async () => [1, 0, 0, 0] });
    expect(results[0].matched).toEqual(['semantic']);
  });

  it('still answers when the model will not load', async () => {
    const results = await search(db, 'compaction', {
      embed: async () => { throw new Error('no network'); },
    });
    expect(results).toHaveLength(1);
    expect(results[0].matched).toEqual(['keyword']);
  });
});

describe('recording what magpie sends', () => {
  it('keeps the summary and indexes the source, when both arrive', () => {
    const { id } = record(db, {
      space_id: 'default',
      content: 'A short summary of the chapter.',
      full_text: 'The chapter compares storage engines. '.repeat(40),
      metadata: { url: 'https://example.com/ddia', title: 'DDIA', captured_at: '2026-09-15T00:00:00Z' },
    });

    const stored = getPage(db, id);
    expect(stored.summary).toBe('A short summary of the chapter.');
    expect(stored.content).toContain('storage engines');
    // the source is what search reaches, not the summary
    expect(ftsSearch(db, 'compares')).not.toHaveLength(0);
  });

  it('indexes the content itself when that is all there is', () => {
    const { id } = record(db, {
      content: 'Only a summary was sent.',
      metadata: { url: 'https://example.com/only' },
    });
    expect(getPage(db, id).summary).toBeNull();
    expect(getPage(db, id).content).toBe('Only a summary was sent.');
  });

  it('refuses a capture with nothing to store or nowhere it came from', () => {
    expect(() => record(db, { metadata: { url: 'https://example.com' } })).toThrow(/content/);
    expect(() => record(db, { content: 'text' })).toThrow(/url/);
  });
});

describe('hydrating results', () => {
  it('returns nothing for nothing, rather than every row', () => {
    upsertPage(db, page(), ['one']);
    expect(hydrate(db, []).size).toBe(0);
  });
});
