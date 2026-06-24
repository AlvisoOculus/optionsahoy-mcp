// AlphaLatitude Inc. © 2026
//
// Runs the QSBS answer contract (qsbs.contract.ts) as tests:
//   Phase 1 — completeness: every applicable requiredFact appears in the answer.
//   Phase 2 — branch-exhaustiveness + no-contradiction: each verdict is covered,
//             the headline frames its state, the answer rejects what would
//             contradict it, and no enumerated verdict lands in the fallback line.
//
// These fail red on the current formatter: caveats renders the "does not appear
// to qualify" fallback (P2), and the per-company cap parenthetical fires on
// verdicts where the cap is not the reason gain is taxable (P9).

import { describe, it, expect } from 'vitest';
import { qsbsContract as c } from './qsbs.contract';

// Pre-compute each scenario once: engine result + rendered answer.
const rendered = c.scenarios.map((s) => ({
  scenario: s,
  result: c.run(s.inputs),
  text: c.format(c.run(s.inputs)),
}));

describe('qsbs contract — scenarios drive the verdict they claim', () => {
  for (const { scenario, result } of rendered) {
    it(`${scenario.name}: engine produces the expected discriminant values`, () => {
      for (const d of c.discriminants) {
        if (scenario.expect[d.field] === undefined) continue;
        expect(d.read(result), `${scenario.name} -> ${d.field}`).toBe(scenario.expect[d.field]);
      }
    });
  }
});

describe('qsbs contract — Phase 1: completeness', () => {
  for (const { scenario, result, text } of rendered) {
    for (const fact of c.requiredFacts) {
      if (!fact.applies(result)) continue;
      it(`${scenario.name}: surfaces "${fact.name}"`, () => {
        expect(fact.present(text, result), `missing "${fact.name}" in:\n${text}`).toBe(true);
      });
    }
  }
});

describe('qsbs contract — Phase 2: branch framing + no contradiction', () => {
  for (const { scenario, text } of rendered) {
    it(`${scenario.name}: headline frames the state`, () => {
      expect(scenario.headlineMatches.test(text), `headline did not match in:\n${text}`).toBe(true);
    });

    for (const rej of scenario.answerRejects ?? []) {
      it(`${scenario.name}: answer rejects ${rej}`, () => {
        expect(rej.test(text), `answer wrongly contained ${rej} in:\n${text}`).toBe(false);
      });
    }
  }

  it('every discriminant value is covered by a scenario', () => {
    for (const d of c.discriminants) {
      const covered = new Set(
        c.scenarios.map((s) => s.expect[d.field]).filter((v): v is string => v !== undefined),
      );
      for (const v of d.values) {
        expect(covered.has(v), `no scenario covers ${d.field}=${v}`).toBe(true);
      }
    }
  });

  it('no enumerated verdict lands in the generic fallback line', () => {
    const allowed = new Set(c.allowFallbackFor ?? []);
    for (const { scenario, text } of rendered) {
      const verdict = scenario.expect.verdict;
      if (verdict && allowed.has(`verdict:${verdict}`)) continue;
      expect(c.fallback.test(text), `verdict=${verdict} fell to the fallback line:\n${text}`).toBe(false);
    }
  });
});
