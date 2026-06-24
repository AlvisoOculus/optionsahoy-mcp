// AlphaLatitude Inc. © 2026
//
// RSU sell-vs-hold answer contract. The discriminant is hold.isLongTerm: the
// engine sets it false for a sub-1-year hold (a short-term tax cliff), but the
// formatter hardcoded "holding the shares for the long-term rate" regardless
// (defect P3). The short-hold scenario fails red until the wording branches on
// isLongTerm and warns about the cliff.

import { computeRsuResult, type RsuInput, type RsuResult } from '@/lib/calc/rsu';
import { headline } from '../../functions/poe';
import type { ToolContract } from './contract-types';

function base(overrides: Partial<RsuInput> = {}): RsuInput {
  return {
    shares: 1000,
    currentPrice: 100,
    ordinaryIncome: 200_000,
    filingStatus: 'single',
    stateCode: 'CA',
    stillEmployed: true,
    holdYears: 2,
    expectedSalePrice: 130,
    haircut: 0.05,
    expectedMarketReturn: 0.08,
    ...overrides,
  };
}

const LONG_TERM_PHRASE = /for the long-term rate/;
const FALLBACK = /Your optimized result is ready/;

export const rsuContract: ToolContract<RsuInput, RsuResult> = {
  tool: 'rsu_sell_vs_hold',
  run: (inputs) => computeRsuResult(inputs),
  format: (result) => headline('rsu_sell_vs_hold', result as any),

  requiredFacts: [
    {
      name: 'tax at vest shown',
      applies: (r) => typeof r.vest?.total === 'number' && r.vest.total > 0,
      present: (t) => /trigger about \$[\d,]+ in tax/.test(t),
    },
    {
      name: 'hold-vs-sell comparison shown',
      applies: (r) => typeof r.hold?.netAtYearN === 'number' && typeof r.sellNowInvest?.netAtYearN === 'number',
      present: (t) => /reaches about \$[\d,]+/.test(t) && /wins by about \$[\d,]+/.test(t),
    },
    {
      name: 'short-term cliff warned when the hold is under a year',
      applies: (r) => r.hold?.isLongTerm === false,
      present: (t) => /short-term|under (a|one) year/i.test(t) && /ordinary/i.test(t),
    },
  ],

  discriminants: [
    {
      field: 'isLongTerm',
      values: ['true', 'false'],
      read: (r) => String(r.hold?.isLongTerm),
    },
  ],

  fallback: FALLBACK,

  scenarios: [
    {
      name: 'long-term hold (held 2 years)',
      inputs: base({ holdYears: 2 }),
      expect: { isLongTerm: 'true' },
      headlineMatches: LONG_TERM_PHRASE,
      answerRejects: [FALLBACK, /short-term sale/, /taxed at your ordinary rate/],
    },
    {
      name: 'short-term hold (held 6 months)',
      inputs: base({ holdYears: 0.5 }),
      expect: { isLongTerm: 'false' },
      headlineMatches: /ordinary rate/,
      answerRejects: [FALLBACK, LONG_TERM_PHRASE],
    },
  ],
};
