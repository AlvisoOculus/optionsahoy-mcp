// AlphaLatitude Inc. © 2026
//
// AMT/ISO answer contract. The discriminant is the exercise-window status.
// Defects: an already-closed window was ignored unless 0 < daysUntilWindowClose
// < 400, so a departed holder past the deadline got an exercise plan as if it
// were actionable (P4); and unused carryforward AMT credit (creditRemaining) was
// shown only when some credit was recovered within the plan (P5). The closed
// scenario and the carryforward fact fail red until both are surfaced.

import { computeAmtIso, type AmtIsoInput, type AmtIsoResult } from '@/lib/calc/amtIso';
import { headline } from '../../functions/poe';
import type { ToolContract } from './contract-types';

const TODAY = new Date('2026-06-24');

function base(o: Partial<AmtIsoInput>): AmtIsoInput {
  return {
    shares: 20000,
    strike: 2,
    fmv: 200,
    expectedGrowth: 0.17,
    volatilityDrag: 0.2,
    filingStatus: 'married_joint',
    ordinaryIncome: 300000,
    stateCode: 'CA',
    carryforwardCredit: 0,
    horizon: 4,
    cashReturnRate: 0.055,
    grantDate: new Date('2022-01-01'),
    hasLeftCompany: false,
    terminationDate: null,
    ...o,
  };
}

const PLAN_HEADLINE = /Exercise your incentive stock options like this|tax-optimal exercise plan/;
const CLOSED = /exercise window has already closed/;
const CARRYFORWARD = /carry about \$[\d,]+ of unused AMT credit/;
const FALLBACK = /Your optimized result is ready/;

export const amtContract: ToolContract<AmtIsoInput, AmtIsoResult> = {
  tool: 'amt_iso_optimize',
  run: (inputs) => computeAmtIso(inputs, TODAY),
  format: (result) => headline('amt_iso_optimize', result as any),

  requiredFacts: [
    {
      name: 'exercise plan / optimal framing shown when the window is open',
      applies: (r) => !r.timing?.windowClosed,
      present: (t) => PLAN_HEADLINE.test(t),
    },
    {
      name: 'most-money-after-taxes line shown',
      applies: (r) => typeof r.schedules?.optimized?.nfv === 'number',
      present: (t) => /most money after taxes/.test(t),
    },
    {
      name: 'extra exercise tax shown',
      applies: (r) => typeof r.schedules?.optimized?.exerciseTax === 'number' && r.schedules.optimized.exerciseTax > 0,
      present: (t) => /add about \$[\d,]+ in tax above your normal bill/.test(t),
    },
    {
      name: 'carryforward AMT credit shown when credit remains past the plan',
      applies: (r) => typeof r.schedules?.optimized?.creditRemaining === 'number' && r.schedules.optimized.creditRemaining > 0,
      present: (t) => CARRYFORWARD.test(t),
    },
    {
      name: 'closed-window warning shown when departed past the deadline',
      applies: (r) => r.timing?.windowClosed === true,
      present: (t) => CLOSED.test(t),
    },
  ],

  discriminants: [
    {
      field: 'windowStatus',
      values: ['open', 'closed'],
      read: (r) => (r.timing?.windowClosed ? 'closed' : 'open'),
    },
  ],

  fallback: FALLBACK,

  scenarios: [
    {
      name: 'open window (employed)',
      inputs: base({}),
      expect: { windowStatus: 'open' },
      headlineMatches: /Exercise your incentive stock options like this/,
      answerRejects: [FALLBACK, CLOSED],
    },
    {
      name: 'closed window (departed, deadline passed)',
      inputs: base({ hasLeftCompany: true, terminationDate: new Date('2025-01-01') }),
      expect: { windowStatus: 'closed' },
      headlineMatches: CLOSED,
      answerRejects: [FALLBACK, /\*\*Exercise your incentive stock options like this/],
    },
  ],
};
