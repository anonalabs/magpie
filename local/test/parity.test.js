import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SHARED, rendered } from '../scripts/sync-lib.mjs';

describe('the copied modules', () => {
  it('are identical to the extension\'s, or the copy has become a fork', () => {
    for (const { from, to } of SHARED) {
      expect(readFileSync(to, 'utf8'), `${to} is stale: run npm run sync:lib`)
        .toBe(rendered(from));
    }
  });
});
