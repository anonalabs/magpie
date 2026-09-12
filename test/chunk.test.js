import { describe, it, expect } from 'vitest';
import {
  CHARS_PER_TOKEN, estimateTokens, inputBudget, chunkText, planSummarisation, reducePlan, splitInHalf,
} from '../src/lib/chunk.js';

const para = (n, word = 'word') => Array.from({ length: n }, () => word).join(' ');
// Measured the way the budget is applied: in tokens, not characters.
const fits = (chunks, budgetTokens) =>
  chunks.every((c) => estimateTokens(c) <= budgetTokens);

describe('inputBudget', () => {
  it('leaves room for the prompt and the answer', () => {
    expect(inputBudget(4096)).toBe(4096 - 150 - 350 - 96);
  });

  it('refuses a context window too small to be useful', () => {
    // Better to fail loudly than to hand the model a 40-token chunk and
    // summarise a document it mostly never saw.
    expect(() => inputBudget(512)).toThrow(RangeError);
  });
});

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('', 100)).toEqual([]);
    expect(chunkText('   \n  ', 100)).toEqual([]);
  });

  it('leaves text that already fits as one untouched chunk', () => {
    const text = 'A short article.\n\nWith two paragraphs.';
    expect(chunkText(text, 1000)).toEqual([text]);
  });

  it('splits on paragraph boundaries and keeps paragraphs whole', () => {
    // Equal-length words, so one budget derived from the first paragraph
    // genuinely describes all three.
    const a = para(20, 'alpha');
    const b = para(20, 'bravo');
    const c = para(20, 'delta');
    const budget = estimateTokens(a) + 5;

    const chunks = chunkText([a, b, c].join('\n\n'), budget);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
    expect(chunks[2]).toBe(c);
  });

  it('packs several small paragraphs into one chunk', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    expect(chunkText(text, 1000)).toHaveLength(1);
  });

  it('never emits a chunk over budget', () => {
    const text = Array.from({ length: 40 }, (_, i) => para(30, `p${i}`)).join('\n\n');
    for (const budget of [60, 120, 400, 1000]) {
      const chunks = chunkText(text, budget);
      expect(fits(chunks, budget), `budget ${budget}`).toBe(true);
    }
  });

  it('falls to sentence boundaries when one paragraph is too big', () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i}.`);
    const chunks = chunkText(sentences.join(' '), 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(fits(chunks, 20)).toBe(true);
    // Having descended to sentences, it should not descend further and break
    // one apart mid-clause.
    for (const chunk of chunks) expect(chunk).toMatch(/\.$/);
  });

  it('hard-splits a single unbroken run rather than exceeding the budget', () => {
    // No spaces, no punctuation, no newlines: every structural boundary fails.
    const chunks = chunkText('x'.repeat(1000), 50);
    expect(fits(chunks, 50)).toBe(true);
    expect(chunks.join('')).toBe('x'.repeat(1000));
  });

  it('loses no words', () => {
    const text = Array.from({ length: 15 }, (_, i) => para(25, `w${i}`)).join('\n\n');
    const rejoined = chunkText(text, 80).join(' ').split(/\s+/).sort();
    expect(rejoined).toEqual(text.split(/\s+/).sort());
  });
});

describe('planSummarisation', () => {
  it('plans a single call for a short page, with no reduce', () => {
    const plan = planSummarisation('A short page.', 4096);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.needsReduce).toBe(false);
    expect(plan.totalCalls).toBe(1);
  });

  it('adds one reduce call when a page is chunked', () => {
    // ~20k words, the case the plan sizes against.
    const text = Array.from({ length: 200 }, (_, i) => para(100, `w${i}`)).join('\n\n');
    const plan = planSummarisation(text, 4096);

    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.needsReduce).toBe(true);
    expect(plan.totalCalls).toBe(plan.chunks.length + 1);
    expect(fits(plan.chunks, plan.budgetTokens)).toBe(true);
  });
});

describe('reducePlan', () => {
  it('reduces in one pass when the joined summaries fit', () => {
    const plan = reducePlan(['First summary.', 'Second summary.'], 1000);
    expect(plan.fits).toBe(true);
    expect(plan.chunks).toHaveLength(1);
  });

  it('reports another round when the joined summaries still overflow', () => {
    const summaries = Array.from({ length: 40 }, (_, i) => para(60, `s${i}`));
    const plan = reducePlan(summaries, 200);
    expect(plan.fits).toBe(false);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(fits(plan.chunks, 200)).toBe(true);
  });
});


describe('estimateTokens', () => {
  it('never under-counts the text that used to break it', () => {
    // A flat length/4 measured 43% low on code and 54% low on URLs, and
    // under-counting overfills the context window — which comes back as an
    // empty summary rather than an error.
    const cases = [
      ['urls', 'see https://app.slack.com/client/T01ABCD/C09XYZ/thread-1757 and ping @alice '.repeat(30), 2.6],
      ['code', 'const x = {a:1,b:[2,3]};\n'.repeat(200), 2.8],
      ['cjk', '日本語のテキストはトークン化が異なります。'.repeat(50), 1.5],
    ];
    for (const [name, text, charsPerRealToken] of cases) {
      const likelyReal = Math.ceil(text.length / charsPerRealToken);
      expect(estimateTokens(text), `${name} must not under-count`).toBeGreaterThanOrEqual(likelyReal);
    }
  });

  it('stays close for ordinary prose, where it was already right', () => {
    const prose = 'the quick brown fox jumps over the lazy dog and keeps running '.repeat(70);
    const likelyReal = Math.ceil(prose.length / 4);
    const estimate = estimateTokens(prose);
    expect(estimate).toBeGreaterThanOrEqual(likelyReal);
    expect(estimate).toBeLessThan(likelyReal * 1.4);   // pessimistic, not absurd
  });

  it('is zero for nothing', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe('chunkText sizes by tokens, not characters', () => {
  it('gives dense text smaller chunks than prose', () => {
    const prose = 'the quick brown fox jumps over the lazy dog '.repeat(400);
    const dense = 'const x = {a:1,b:[2,3]}; // https://example.com/a/b?c=1\n'.repeat(400);

    const proseChunks = chunkText(prose, 500);
    const denseChunks = chunkText(dense, 500);

    expect(fits(proseChunks, 500)).toBe(true);
    expect(fits(denseChunks, 500)).toBe(true);
    // Same budget, denser text: the pieces have to be shorter in characters.
    const avg = (chunks) => chunks.reduce((n, c) => n + c.length, 0) / chunks.length;
    expect(avg(denseChunks)).toBeLessThan(avg(proseChunks));
  });
});

describe('splitInHalf', () => {
  it('cuts at a paragraph boundary near the middle', () => {
    const [left, right] = splitInHalf('one two three\n\nfour five six');
    expect(left).toBe('one two three');
    expect(right).toBe('four five six');
  });

  it('falls to a sentence boundary when there are no paragraphs', () => {
    const [left, right] = splitInHalf('First sentence here. Second sentence here.');
    expect(left).toBe('First sentence here.');
    expect(right).toBe('Second sentence here.');
  });

  it('cuts an unbroken run rather than giving up', () => {
    const halves = splitInHalf('x'.repeat(100));
    expect(halves).toHaveLength(2);
    expect(halves.join('')).toBe('x'.repeat(100));
  });

  it('says it cannot be split when it cannot', () => {
    // The caller needs to tell "smaller" from "cannot be made smaller".
    expect(splitInHalf('x')).toEqual(['x']);
    expect(splitInHalf('')).toEqual([]);
  });

  it('loses nothing', () => {
    const text = 'alpha bravo\n\ncharlie delta\n\necho foxtrot';
    expect(splitInHalf(text).join(' ').split(/\s+/).sort())
      .toEqual(text.split(/\s+/).sort());
  });
});
