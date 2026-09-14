import { describe, it, expect } from 'vitest';
import {
  googleDoc, looksLikeGoogleDoc, docTitle, looksLikeSignIn, docBody, MAX_CHARS,
} from '../src/lib/google-docs.js';

const ID = '1a2B3c4D5e6F7g8H9i0JklmnopQRSTuvwxyz';

describe('recognising a Google document', () => {
  it('reads a document URL', () => {
    const doc = googleDoc(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`);
    expect(doc.kind).toBe('document');
    expect(doc.id).toBe(ID);
    expect(doc.exportPath).toBe(`/document/d/${ID}/export?format=txt`);
  });

  it('reads a spreadsheet, and keeps the tab the reader is looking at', () => {
    const doc = googleDoc(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1830572`);
    expect(doc.kind).toBe('spreadsheet');
    expect(doc.exportPath).toBe(`/spreadsheets/d/${ID}/export?format=csv&gid=1830572`);
  });

  it('exports the first sheet when no tab is named', () => {
    expect(googleDoc(`https://docs.google.com/spreadsheets/d/${ID}/edit`).exportPath)
      .toBe(`/spreadsheets/d/${ID}/export?format=csv`);
  });

  it('reads a presentation', () => {
    expect(googleDoc(`https://docs.google.com/presentation/d/${ID}/edit#slide=id.p1`).exportPath)
      .toBe(`/presentation/d/${ID}/export/txt`);
  });

  it('leaves a published doc alone, because that one is real HTML already', () => {
    expect(googleDoc('https://docs.google.com/document/d/e/2PACX-1vABC/pub')).toBeNull();
  });

  it('is not fooled by a lookalike host', () => {
    expect(googleDoc(`https://docs.google.com.evil.example/document/d/${ID}/edit`)).toBeNull();
    expect(looksLikeGoogleDoc('https://example.com/document/d/x/edit')).toBe(false);
  });

  it('ignores the rest of Google', () => {
    expect(googleDoc('https://drive.google.com/drive/my-drive')).toBeNull();
    expect(googleDoc('https://docs.google.com/forms/d/abc/viewform')).toBeNull();
    expect(googleDoc('not a url')).toBeNull();
  });
});

describe('the document title', () => {
  it('drops the product name the tab title carries', () => {
    expect(docTitle('Q3 planning - Google Docs', 'document')).toBe('Q3 planning');
    expect(docTitle('Budget - Google Sheets', 'spreadsheet')).toBe('Budget');
  });

  it('leaves a title that does not carry one', () => {
    expect(docTitle('Q3 planning', 'document')).toBe('Q3 planning');
  });

  it('keeps a document actually named after the product', () => {
    expect(docTitle('Google Docs - Google Docs', 'document')).toBe('Google Docs');
  });
});

describe('telling a document from a sign-in wall', () => {
  it('knows an HTML answer is not the export', () => {
    expect(looksLikeSignIn('<!DOCTYPE html><html><head>', 'text/html; charset=utf-8')).toBe(true);
    expect(looksLikeSignIn('anything at all', 'text/html')).toBe(true);
  });

  it('accepts the real thing', () => {
    expect(looksLikeSignIn('Q3 planning\n\nThe quarter opens with', 'text/plain')).toBe(false);
  });

  it('catches an HTML body served with no content type', () => {
    expect(looksLikeSignIn('<html><body>Sign in</body></html>')).toBe(true);
  });
});

describe('capping a very large document', () => {
  it('leaves a normal document alone', () => {
    const body = docBody('A short document.', 'Google Doc');
    expect(body.text).toBe('A short document.');
    expect(body.truncated).toBe(false);
    expect(body.charsRead).toBe(body.charsTotal);
  });

  it('caps a book, and says so in the text', () => {
    const body = docBody('x'.repeat(MAX_CHARS * 2), 'Google Doc');
    expect(body.charsRead).toBe(MAX_CHARS);
    expect(body.truncated).toBe(true);
    expect(body.text).toContain('first 50% of this Google Doc');
  });

  it('normalises line endings so the chunker sees real paragraphs', () => {
    expect(docBody('one\r\n\r\ntwo', 'Google Doc').text).toBe('one\n\ntwo');
  });
});
