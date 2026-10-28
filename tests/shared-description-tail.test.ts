// AlphaLatitude Inc. © 2026
//
// Guard: text appended to several tool descriptions (STRICT_INPUT_NOTE and
// friends in mcp-tools.ts) counts against every one of them in Glama's
// Disambiguation score, which rates how clearly each description sets its
// tool apart. The longest tail any two descriptions shared was 1295 chars
// while the score was 5; #268/#269 grew it to 1452 and the score fell to 4 on
// 2026-10-04. The 2026-10-21 trim cut it to 868. The cap sits below the last
// length known to score 5. Raise it only with a reason in mcp-tools.ts.

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../functions/_lib/mcp-tools';

const SHARED_TAIL_CAP = 1000;

function sharedTailLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

describe('tool descriptions do not end in long shared boilerplate', () => {
  for (const [i, a] of TOOLS.entries()) {
    for (const b of TOOLS.slice(i + 1)) {
      it(`${a.name} and ${b.name}`, () => {
        const n = sharedTailLength(String(a.description), String(b.description));
        expect(n, `${a.name} and ${b.name} end in the same ${n} characters`).toBeLessThanOrEqual(SHARED_TAIL_CAP);
      });
    }
  }
});
