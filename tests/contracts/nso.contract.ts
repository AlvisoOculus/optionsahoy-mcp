// AlphaLatitude Inc. © 2026
//
// NSO answer contract. NSO has no verdict-style discriminant (the hold path is
// always long-term: the engine clamps holdYears to >=1), so this contract is
// completeness-focused. Its key bind is P6 (Phase 3, number reconciliation): the
// hold-vs-sell comparison runs on hold.effectiveSalePrice (the expected price
// trimmed for single-stock volatility), which used to go undisclosed while the
// assumptions line stated the raw expected price. The effective-price fact
// asserts the disclosed number equals the engine's effectiveSalePrice.

import { computeNsoResult, type NsoInput, type NsoResult } from '@/lib/calc/nso';
import { headline } from '../../functions/poe';
import type { ToolContract } from './contract-types';

function base(o: Partial<NsoInput> = {}): NsoInput {
  return {
    shares: 5000,
    strike: 10,
    currentPrice: 50,
    ordinaryIncome: 180000,
    filingStatus: 'single',
    stateCode: 'CA',
    stillEmployed: true,
    holdYears: 2,
    expectedSalePrice: 130,
    haircut: 0.15,
    expectedMarketReturn: 0.08,
    holdFunding: 'sell-to-cover',
    ...o,
  };
}

const FALLBACK = /Your optimized result is ready/;

export const nsoContract: ToolContract<NsoInput, NsoResult> = {
  tool: 'nso_calculate',
  run: (inputs) => computeNsoResult(inputs),
  format: (result) => headline('nso_calculate', result as any),

  requiredFacts: [
    {
      name: 'tax-at-exercise shown',
      applies: (r) => typeof r.exercise?.total === 'number',
      present: (t) => /trigger about \$[\d,]+ in tax right now/.test(t),
    },
    {
      name: 'hold-vs-sell comparison shown',
      applies: (r) => typeof r.hold?.netAtYearN === 'number' && typeof r.sellNowInvest?.netAtYearN === 'number',
      present: (t) => /Holding wins by about \$[\d,]+|Selling wins by about \$[\d,]+/.test(t),
    },
    {
      name: 'effective sale price disclosed and equal to the engine value',
      applies: (r) => typeof r.hold?.effectiveSalePrice === 'number',
      present: (t, r) => {
        const eff = Math.round(r.hold.effectiveSalePrice);
        return new RegExp(`effective sale price of about \\$${eff.toLocaleString('en-US')}`).test(t);
      },
    },
  ],

  discriminants: [],

  fallback: FALLBACK,

  scenarios: [
    {
      name: 'standard NSO (2-year hold, 15% haircut)',
      inputs: base(),
      expect: {},
      headlineMatches: /Exercising these options would trigger about \$[\d,]+ in tax right now/,
      answerRejects: [FALLBACK],
    },
  ],
};
