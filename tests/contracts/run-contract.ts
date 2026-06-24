// AlphaLatitude Inc. © 2026
//
// Shared runner for the per-tool answer contracts (contract-types.ts). Each
// <tool>.contract.test.ts calls registerContractTests(contract) to get:
//   - scenario sanity: the engine produces the discriminant values claimed.
//   - Phase 1 (completeness): every applicable requiredFact appears in the answer.
//   - Phase 2 (branch-exhaustiveness + no-contradiction): each value is covered,
//     the answer frames its state, rejects what would contradict it, and no
//     enumerated value lands in the generic fallback line.

import { describe, it, expect } from 'vitest';
import type { ToolContract } from './contract-types';

export function registerContractTests(c: ToolContract): void {
  const rendered = c.scenarios.map((s) => {
    const result = c.run(s.inputs);
    return { scenario: s, result, text: c.format(result) };
  });

  describe(`${c.tool} contract — scenarios drive the state they claim`, () => {
    for (const { scenario, result } of rendered) {
      it(`${scenario.name}: engine produces the expected discriminant values`, () => {
        for (const d of c.discriminants) {
          if (scenario.expect[d.field] === undefined) continue;
          expect(d.read(result), `${scenario.name} -> ${d.field}`).toBe(scenario.expect[d.field]);
        }
      });
    }
  });

  describe(`${c.tool} contract — Phase 1: completeness`, () => {
    for (const { scenario, result, text } of rendered) {
      for (const fact of c.requiredFacts) {
        if (!fact.applies(result)) continue;
        it(`${scenario.name}: surfaces "${fact.name}"`, () => {
          expect(fact.present(text, result), `missing "${fact.name}" in:\n${text}`).toBe(true);
        });
      }
    }
  });

  describe(`${c.tool} contract — Phase 2: branch framing + no contradiction`, () => {
    for (const { scenario, text } of rendered) {
      it(`${scenario.name}: answer frames the state`, () => {
        expect(scenario.headlineMatches.test(text), `did not match ${scenario.headlineMatches} in:\n${text}`).toBe(true);
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

    it('no enumerated state lands in the generic fallback line', () => {
      const allowed = new Set(c.allowFallbackFor ?? []);
      for (const { scenario, text } of rendered) {
        const allowedHere = c.discriminants.some((d) => {
          const v = scenario.expect[d.field];
          return v !== undefined && allowed.has(`${d.field}:${v}`);
        });
        if (allowedHere) continue;
        expect(c.fallback.test(text), `${scenario.name} fell to the fallback line:\n${text}`).toBe(false);
      }
    });
  });
}
