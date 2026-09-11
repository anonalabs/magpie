import { describe, it, expect } from 'vitest';
import {
  CHARS_PER_TOKEN, estimateTokens, inputBudget, chunkText, planSummarisation, reducePlan,
} from '../src/lib/chunk.js';

const para = (n, word = 'word') => Array.from({ length: n }, () => word).join(' ');
const fits = (chunks, budgetTokens) =>
  chunks.every((c) => c.length <= budgetTokens * CHARS_PER_TOKEN);

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
