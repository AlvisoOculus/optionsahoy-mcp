// AlphaLatitude Inc. © 2026
//
// Math correctness for computeEquityFundingComparison is exercised by the
// 73-test parallel suite in optionsahoy_web (calc files are byte-identical).
// Here we only verify the parser + comparison wiring at the MCP edge.

import { describe, it, expect } from 'vitest';
import { parseEquityFundingInput } from '../functions/_lib/calc-parsers';
import { computeEquityFundingComparison } from '../lib/calc/equityFunding';
import { getTrailingReturn } from '../lib/data/trailing-returns';

const BASE = {
  targetAfterTax: 200_000,
  targetDate: '2028-06-01',
  today: '2026-06-01',
  ordinaryIncome: 250_000,
  filingStatus: 'single',
  stateCode: 'CA',
  cashInterestRate: 0.04,
  stacks: [
    {
      currentPrice: 100,
      expectedAnnualGrowth: 0.08,
      lots: [
        { shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' },
      ],
    },
  ],
};

describe('equity_funding_plan comparison output (v1.8)', () => {
  it('returns recommended + lockInNow + balanced + holdForGrowth + frontier', () => {
    const input = parseEquityFundingInput(BASE);
    const out = computeEquityFundingComparison(input);
    expect(out.recommended).toBeDefined();
    expect(out.lockInNow).toBeDefined();
    expect(out.balanced).toBeDefined();
    expect(out.holdForGrowth).toBeDefined();
    expect(Array.isArray(out.frontier)).toBe(true);
    expect(out.recommended.shortfallProbability).toBeLessThanOrEqual(
      out.holdForGrowth.shortfallProbability + 1e-9,
    );
    // Lock-in-now is deterministic when feasible (zero exposure to future prices).
    if (out.lockInNow.plan.feasible) {
      expect(out.lockInNow.shortfallProbability).toBe(0);
    }
  });

  it('honors riskToleranceShortfall (tighter tolerance → recommendation shifts toward lock-in)', () => {
    const looseInput = parseEquityFundingInput({ ...BASE, riskToleranceShortfall: 0.5 });
    const tightInput = parseEquityFundingInput({ ...BASE, riskToleranceShortfall: 0.01 });
    const loose = computeEquityFundingComparison(looseInput);
    const tight = computeEquityFundingComparison(tightInput);
    // Tighter risk tolerance → recommendation cannot have HIGHER shortfall than loose tolerance.
    expect(tight.recommended.shortfallProbability).toBeLessThanOrEqual(
      loose.recommended.shortfallProbability + 1e-9,
    );
  });

  it('recommended is never dominated by a feasible frontier plan (efficient-frontier invariant)', () => {
    // Regression ported from optionsahoy_web: recommended was selected from a
    // narrow pool excluding the hybrid sweep, so a feasible frontier plan could
    // dominate it (more wealth at equal-or-lower shortfall). Sweep tolerances.
    for (const tol of [0.005, 0.01, 0.02, 0.05, 0.1, 0.3]) {
      const out = computeEquityFundingComparison(
        parseEquityFundingInput({ ...BASE, riskToleranceShortfall: tol }),
      );
      const rec = out.recommended;
      const maxW = Math.max(...out.frontier.map((p) => p.wealthAtTarget), rec.wealthAtTarget);
      const tieEps = Math.max(100, maxW * 5e-4);
      for (const p of out.frontier) {
        if (!p.plan.feasible) continue;
        if (p.shortfallProbability > tol + 1e-9) continue;
        const dominates =
          p.wealthAtTarget > rec.wealthAtTarget + tieEps &&
          p.shortfallProbability <= rec.shortfallProbability + 1e-9;
        expect(dominates).toBe(false);
      }
    }
  });

  it('recommended breaks wealth ties toward lower shortfall risk', () => {
    for (const tol of [0.01, 0.05, 0.1, 0.3]) {
      const out = computeEquityFundingComparison(
        parseEquityFundingInput({ ...BASE, riskToleranceShortfall: tol }),
      );
      const rec = out.recommended;
      const maxW = Math.max(...out.frontier.map((p) => p.wealthAtTarget), rec.wealthAtTarget);
      const tieEps = Math.max(100, maxW * 5e-4);
      for (const p of out.frontier) {
        if (!p.plan.feasible) continue;
        if (p.shortfallProbability > tol + 1e-9) continue;
        if (Math.abs(p.wealthAtTarget - rec.wealthAtTarget) <= tieEps) {
          expect(p.shortfallProbability).toBeGreaterThanOrEqual(rec.shortfallProbability - 1e-9);
        }
      }
    }
  });

  it('parses ticker into stack expectedAnnualGrowth via trailing CAGR', () => {
    const nvdaCagr = getTrailingReturn('NVDA', 2);
    expect(nvdaCagr).not.toBeNull();
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          ticker: 'NVDA',
          currentPrice: 100,
          lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
        },
      ],
    });
    expect(input.stacks![0]!.expectedAnnualGrowth).toBeCloseTo(nvdaCagr!, 6);
  });

  it('forwards per-stack volatility into stackVolatilities (parallel to stacks)', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          currentPrice: 100,
          expectedAnnualGrowth: 0.08,
          volatility: 0.45,
          lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
        },
        {
          currentPrice: 50,
          expectedAnnualGrowth: 0.05,
          lots: [{ shares: 2000, costBasisPerShare: 10, acquisitionDate: '2023-01-15' }],
        },
      ],
    });
    expect(input.stackVolatilities).toEqual([0.45, null]);
  });

  it('omits stackVolatilities entirely when no stack supplies a vol', () => {
    const input = parseEquityFundingInput(BASE);
    expect(input.stackVolatilities).toBeUndefined();
  });

  it('parses optional vestDate on a lot for unvested RSU tranches', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          currentPrice: 100,
          expectedAnnualGrowth: 0.08,
          lots: [
            { shares: 1000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' },
            { shares: 500, costBasisPerShare: 0, acquisitionDate: '2027-01-01', vestDate: '2027-01-01' },
          ],
        },
      ],
    });
    expect(input.stacks![0]!.lots[1]!.vestDate).toBeInstanceOf(Date);
  });

  it('forwards riskToleranceShortfall and defaultVolatility through the parser', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      riskToleranceShortfall: 0.05,
      defaultVolatility: 0.5,
    });
    expect(input.riskToleranceShortfall).toBe(0.05);
    expect(input.defaultVolatility).toBe(0.5);
  });

  it('legacy single-stack input still parses (no stacks, top-level lots + currentPrice)', () => {
    const input = parseEquityFundingInput({
      targetAfterTax: 200_000,
      targetDate: '2028-06-01',
      today: '2026-06-01',
      ordinaryIncome: 250_000,
      filingStatus: 'single',
      stateCode: 'CA',
      lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
      currentPrice: 100,
      expectedAnnualGrowth: 0.08,
    });
    expect(input.stacks).toBeUndefined();
    expect(input.lots).toBeDefined();
    expect(input.currentPrice).toBe(100);
    const out = computeEquityFundingComparison(input);
    expect(out.recommended).toBeDefined();
  });
});
