import { describe, it, expect } from 'vitest';
import { composeContent, captureMetadata, NOTE_SEPARATOR } from '../src/lib/compose.js';

describe('composeContent', () => {
  it('leaves a capture with no note exactly as it was', () => {
    // The guarantee that matters: adding an optional field must not change one
    // byte of the path almost every capture takes.
    const body = 'The summary the model wrote.';
    expect(composeContent(undefined, body)).toBe(body);
    expect(composeContent('', body)).toBe(body);
    expect(composeContent('   \n ', body)).toBe(body);
  });

  it('puts the note first, separated from what was captured', () => {
    expect(composeContent('for the caching rewrite', 'LSM-trees write sequentially.'))
      .toBe(`for the caching rewrite${NOTE_SEPARATOR}LSM-trees write sequentially.`);
  });

  it('trims without mangling the middle', () => {
    expect(composeContent('  a note  ', '  a body  ')).toBe(`a note${NOTE_SEPARATOR}a body`);
  });

  it('survives a note with nothing captured', () => {
    expect(composeContent('just this thought', '')).toBe('just this thought');
  });

  it('is empty when there is nothing at all', () => {
    expect(composeContent('', '')).toBe('');
    expect(composeContent(undefined, undefined)).toBe('');
  });
});

describe('captureMetadata', () => {
  const base = {
    url: 'https://example.com/a', title: 'A Page',
    capturedAt: '2026-09-11T00:00:00.000Z', mode: 'distill',
  };

  it('is unchanged for an ordinary capture', () => {
    expect(captureMetadata(base)).toEqual({
      url: 'https://example.com/a',
      title: 'A Page',
      captured_at: '2026-09-11T00:00:00.000Z',
      source: 'magpie',
      mode: 'distill',
    });
  });

  it('mirrors a note for provenance', () => {
    expect(captureMetadata({ ...base, note: 'why I kept it' }).note).toBe('why I kept it');
  });

  it('does not record a note that is only whitespace', () => {
    expect(captureMetadata({ ...base, note: '   ' })).not.toHaveProperty('note');
  });

  it('marks a selection, and says nothing about an ordinary page', () => {
    expect(captureMetadata({ ...base, sourceKind: 'selection' }).source_kind).toBe('selection');
    expect(captureMetadata({ ...base, sourceKind: 'page' })).not.toHaveProperty('source_kind');
  });
});
