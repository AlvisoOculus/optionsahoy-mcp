// AlphaLatitude Inc. © 2026
//
// Concentration answer contract. The discriminant is long-term status today
// (already vs waiting). When the position is still short-term the engine returns
// waitForLtInsight.savings — the dollar tax saved by waiting for long-term
// treatment — but the formatter only said it was "usually worth it" and dropped
// the number (defect P7). The waiting scenario fails red until the saving shows.

import { calculate, type ConcentrationInputs, type ConcentrationOutputs } from '@/lib/calc/concentration';
import { headline } from '../../functions/poe';
import type { ToolContract } from './contract-types';

// Fixed "now" so days-until-long-term and the verdict are deterministic.
const NOW = new Date('2026-06-24');

function input(o: Partial<ConcentrationInputs>): ConcentrationInputs {
  return {
    positionValue: 400_000,
    costBasis: 100_000,
    acquisitionDate: new Date('2026-01-01'),
    sector: 'tech_software' as any,
    stateCode: 'CA',
    filingStatus: 'single',
    ordinaryIncome: 200_000,
    totalAssets: 1_200_000,
    expectedPositionReturn: 0.12,
    expectedMarketReturn: 0.08,
    volatilityDrag: 0.2,
    ...o,
  };
}

const WAIT_SAVING = /cut your tax by about \$[\d,]+/;
const ALREADY_LT = /already qualifies for the lower long-term/;
const FALLBACK = /Your optimized result is ready/;

export const concentrationContract: ToolContract<ConcentrationInputs, ConcentrationOutputs> = {
  tool: 'concentration_analyze',
  run: (inputs) => calculate(inputs, NOW),
  format: (result) => headline('concentration_analyze', result as any),

  requiredFacts: [
    {
      name: 'risk band shown',
      applies: (r) => typeof r.riskBand === 'string',
      present: (t) => /Single-stock risk level:/.test(t),
    },
    {
      name: 'concentration share shown',
      applies: (r) => typeof r.concentration === 'number',
      present: (t) => /of your liquid net worth/.test(t),
    },
    {
      name: 'wait-for-long-term dollar saving shown',
      applies: (r) => !!r.waitForLtInsight && typeof r.waitForLtInsight.savings === 'number' && r.waitForLtInsight.savings > 0,
      present: (t) => WAIT_SAVING.test(t),
    },
    {
      name: 'already-long-term stated when held a year+',
      applies: (r) => r.isLongTermToday === true,
      present: (t) => ALREADY_LT.test(t),
    },
  ],

  discriminants: [
    {
      field: 'longTermStatus',
      values: ['already', 'waiting'],
      read: (r) => (r.isLongTermToday ? 'already' : 'waiting'),
    },
  ],

  fallback: FALLBACK,

  scenarios: [
    {
      name: 'still short-term (waiting for long-term)',
      inputs: input({ acquisitionDate: new Date('2026-01-01') }),
      expect: { longTermStatus: 'waiting' },
      headlineMatches: WAIT_SAVING,
      answerRejects: [FALLBACK, ALREADY_LT],
    },
    {
      name: 'already long-term (held years)',
      inputs: input({ acquisitionDate: new Date('2022-01-01') }),
      expect: { longTermStatus: 'already' },
      headlineMatches: ALREADY_LT,
      answerRejects: [FALLBACK, WAIT_SAVING, /Wait about \d+ days/],
    },
  ],
};
