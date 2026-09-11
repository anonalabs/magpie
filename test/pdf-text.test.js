import { describe, it, expect } from 'vitest';
import { joinPages, truncationNotice, pdfBody, looksLikePdf, MAX_PAGES } from '../src/lib/pdf-text.js';

const pages = (n, word = 'page') => Array.from({ length: n }, (_, i) => `${word} ${i} content`);

describe('joinPages', () => {
  it('separates pages with a blank line, so page breaks read as paragraphs', () => {
    expect(joinPages(['one', 'two'])).toBe('one\n\ntwo');
  });

  it('drops pages with nothing on them', () => {
    // A blank page between two real ones must not become a double gap that the
    // chunker reads as a section boundary.
    expect(joinPages(['one', '   ', '', 'two'])).toBe('one\n\ntwo');
  });

  it('survives pdf.js handing back nothing for a page', () => {
    expect(joinPages([null, 'one', undefined])).toBe('one');
  });
});

describe('truncationNotice', () => {
  it('says nothing when the whole document was read', () => {
    expect(truncationNotice(12, 12)).toBe('');
    expect(truncationNotice(40, 3)).toBe('');
  });

  it('names both numbers when it was not', () => {
    expect(truncationNotice(40, 312)).toBe('(Summarised from the first 40 of 312 pages.)');
  });
});

describe('pdfBody', () => {
  it('passes a short document through untouched', () => {
    const body = pdfBody(pages(3), 3);
    expect(body.truncated).toBe(false);
    expect(body.pagesRead).toBe(3);
    expect(body.text).not.toMatch(/Summarised from/);
  });

  it('caps a long one and says so in the text, not just in the fields', () => {
    const body = pdfBody(pages(312), 312);
    expect(body.pagesRead).toBe(MAX_PAGES);
    expect(body.truncated).toBe(true);
    // In the content, because that is the half a memory layer actually extracts.
    expect(body.text).toContain(`(Summarised from the first ${MAX_PAGES} of 312 pages.)`);
    expect(body.text).toContain('page 0 content');
    expect(body.text).not.toContain(`page ${MAX_PAGES} content`);
  });

  it('caps exactly at the boundary, not one either side', () => {
    expect(pdfBody(pages(MAX_PAGES), MAX_PAGES).truncated).toBe(false);
    expect(pdfBody(pages(MAX_PAGES + 1), MAX_PAGES + 1).truncated).toBe(true);
  });
});

describe('looksLikePdf', () => {
  it('recognises one before anything has been fetched', () => {
    expect(looksLikePdf('https://example.com/paper.pdf')).toBe(true);
    // A query string is not part of the name.
    expect(looksLikePdf('https://example.com/paper.pdf?download=1')).toBe(true);
    expect(looksLikePdf('https://example.com/PAPER.PDF')).toBe(true);
  });

  it('does not mistake an article that mentions one', () => {
    expect(looksLikePdf('https://example.com/about-pdf-files')).toBe(false);
    expect(looksLikePdf('https://example.com/?file=x.pdf')).toBe(false);
    expect(looksLikePdf('not a url')).toBe(false);
  });
});
