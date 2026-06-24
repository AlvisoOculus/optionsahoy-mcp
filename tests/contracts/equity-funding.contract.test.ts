// AlphaLatitude Inc. © 2026
//
// Runs the equity-funding answer contract (equity-funding.contract.ts). Fails red
// on the pre-fix formatter: an infeasible goal (recommended.plan.feasible ===
// false) was rendered as a success with the full goal as the net target and the
// "leaves the most expected wealth" framing (defect P1).

import { describe, it, expect } from 'vitest';
import { computeEquityFundingComparison } from '@/lib/calc/equityFunding';
import { equityFundingContract } from './equity-funding.contract';
import { registerContractTests } from './run-contract';

registerContractTests(equityFundingContract);

// The trade-off line shows the three FIXED strategies (lockInNow / balanced /
// holdForGrowth). They are computed independently of riskToleranceShortfall --
// only the `recommended` pick depends on it. So changing only the risk tolerance
// must NOT change those figures. A user saw them shift between a 10% and a 2%
// follow-up; that can only happen if the underlying assumptions (price, growth,
// volatility) drifted across turns, never from the tolerance itself. This pins
// the invariant so an engine regression that couples them would fail.
describe('equity_funding: trade-off figures are invariant to riskToleranceShortfall', () => {
  const baseInput = {
    targetAfterTax: 400_000,
    targetDate: new Date('2028-06-01'),
    today: new Date('2026-06-24'),
    stacks: [
      {
        ticker: 'NVDA',
        currentPrice: 140,
        expectedAnnualGrowth: 0.15,
        volatility: 0.45,
        lots: [{ shares: 4000, costBasisPerShare: 60, acquisitionDate: new Date('2023-06-15') }],
      },
    ],
    ordinaryIncome: 280_000,
    filingStatus: 'married_joint' as const,
    stateCode: 'CA',
    cashInterestRate: 0.04,
  };

  const at = (tol: number) => computeEquityFundingComparison({ ...baseInput, riskToleranceShortfall: tol } as any);
  const named = (r: any, k: 'lockInNow' | 'balanced' | 'holdForGrowth') => ({
    wealth: Math.round(r[k].wealthAtTarget),
    shortfall: Number(r[k].shortfallProbability.toFixed(4)),
  });

  const lo = at(0.02);
  const hi = at(0.10);

  for (const k of ['lockInNow', 'balanced', 'holdForGrowth'] as const) {
    it(`${k} is identical at 2% and 10% tolerance`, () => {
      expect(named(lo, k)).toEqual(named(hi, k));
    });
  }
});
