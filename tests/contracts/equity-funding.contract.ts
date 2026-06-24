// AlphaLatitude Inc. © 2026
//
// Equity-funding answer contract. The discriminant is recommended.plan.feasible:
// when the after-tax goal exceeds what the holdings can net by the deadline the
// engine returns feasible=false plus a shortfall {maxAchievableAfterTax, gap},
// but the formatter ignored both and rendered an infeasible goal as a success
// ("sell N shares to net $50,000,000 ... leaves the most expected wealth") —
// defect P1. The infeasible scenario fails red until the answer leads with the
// gap and frames the schedule as the most that can be raised.

import { computeEquityFundingComparison } from '@/lib/calc/equityFunding';
import { parseEquityFundingInput } from '../../functions/_lib/calc-parsers';
import { headline } from '../../functions/poe';
import type { ToolContract } from './contract-types';

function base(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    targetAfterTax: 400_000,
    targetDate: '2028-06-01',
    stacks: [
      {
        ticker: 'NVDA',
        currentPrice: 140,
        expectedAnnualGrowth: 0.15,
        volatility: 0.45,
        lots: [{ shares: 4000, costBasisPerShare: 60, acquisitionDate: '2023-06-15' }],
      },
    ],
    ordinaryIncome: 280_000,
    filingStatus: 'married_joint',
    stateCode: 'CA',
    cashInterestRate: 0.04,
    riskToleranceShortfall: 0.1,
    ...overrides,
  };
}

const SUCCESS_WEALTH = /leaves the most expected wealth/;
const INFEASIBLE = /more than this equity can net by your deadline/;
const FALLBACK = /Your optimized result is ready/;

export const equityFundingContract: ToolContract<Record<string, any>, any> = {
  tool: 'equity_funding_plan',
  run: (args) => computeEquityFundingComparison(parseEquityFundingInput(args)),
  format: (result) => headline('equity_funding_plan', result as any),

  requiredFacts: [
    {
      name: 'feasible: schedule lists shares to sell',
      applies: (r) => r.recommended?.plan?.feasible !== false,
      present: (t) => /sell [\d,]+ shares/.test(t),
    },
    {
      name: 'feasible: explains why this plan is best (expected wealth)',
      applies: (r) => r.recommended?.plan?.feasible !== false,
      present: (t) => SUCCESS_WEALTH.test(t),
    },
    {
      name: 'infeasible: surfaces the after-tax max and the gap',
      applies: (r) => r.recommended?.plan?.feasible === false,
      present: (t) => /nets about \$[\d,]+ after tax/.test(t) && /\$[\d,]+ short of/.test(t),
    },
  ],

  discriminants: [
    {
      field: 'feasible',
      values: ['true', 'false'],
      read: (r) => String(r.recommended?.plan?.feasible),
    },
  ],

  fallback: FALLBACK,

  scenarios: [
    {
      name: 'feasible (reachable goal)',
      inputs: base(),
      expect: { feasible: 'true' },
      headlineMatches: /Your sell schedule, [\d,]+ shares in total to net .* after tax/,
      answerRejects: [FALLBACK, INFEASIBLE],
    },
    {
      name: 'infeasible (goal exceeds what the holdings can net)',
      inputs: base({ targetAfterTax: 50_000_000 }),
      expect: { feasible: 'false' },
      headlineMatches: INFEASIBLE,
      answerRejects: [FALLBACK, SUCCESS_WEALTH, /safe to aggressive/],
    },
  ],
};
