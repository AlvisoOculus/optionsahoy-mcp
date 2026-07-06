// AlphaLatitude Inc. © 2026
//
// Protective-put answer contract. The discriminant is recommended
// (protective-put | collar | none). The formatter never surfaced the engine's
// pick and instead made an ad-hoc "the collar is usually the better value" call
// on a single ratio, which can disagree with recommended; it also omitted the
// holding-period straddle tax caution the web tool shows (defect P8). Each
// scenario asserts the recommendation matches the engine and rejects the copy of
// the other picks; the straddle note is required on every answer.

import { calculateProtectivePut, type ProtectivePutInputs, type ProtectivePutResult } from '@/lib/calc/protectivePut';
import { headline } from '../../functions/poe';
import type { ToolContract } from './contract-types';

function input(o: Partial<ProtectivePutInputs>): ProtectivePutInputs {
  return {
    positionValue: 400_000,
    sector: 'tech_software' as any,
    volatility: 0.3,
    protectionLevel: 0.1,
    tenorYears: 1 as any,
    ...o,
  };
}

const PICK_PUT = /Our take: the protective put fits best/;
const PICK_COLLAR = /the zero-cost collar is the better value/;
const PICK_SPREAD = /Our take: the put spread fits best/;
const PICK_NONE = /Neither is a clean win/;
const STRADDLE = /straddle rules under Section 1092/;
const FALLBACK = /Your optimized result is ready/;

export const protectivePutContract: ToolContract<ProtectivePutInputs, ProtectivePutResult> = {
  tool: 'protective_put_price',
  run: (inputs) => calculateProtectivePut(inputs),
  format: (result) => headline('protective_put_price', result as any),

  requiredFacts: [
    {
      name: 'protective put structure shown',
      applies: (r) => typeof r.barePut?.maxLoss === 'number',
      present: (t) => /Protective put: .*caps your loss at about \$[\d,]+/.test(t),
    },
    {
      name: 'collar structure shown',
      applies: (r) => typeof r.collar?.maxLoss === 'number',
      present: (t) => /collar: .*caps your loss at about \$[\d,]+/.test(t),
    },
    {
      name: 'put spread structure shown when available',
      applies: (r) => r.putSpread?.available === true,
      present: (t) => /Put spread: .*protection stops at \$[\d,]+/.test(t),
    },
    {
      name: 'a recommendation is surfaced',
      applies: () => true,
      present: (t) => PICK_PUT.test(t) || PICK_COLLAR.test(t) || PICK_SPREAD.test(t) || PICK_NONE.test(t),
    },
    {
      name: 'holding-period straddle tax caution shown',
      applies: () => true,
      present: (t) => STRADDLE.test(t),
    },
  ],

  discriminants: [
    {
      field: 'recommended',
      values: ['protective-put', 'collar', 'put-spread', 'none'],
      read: (r) => String(r.recommended),
    },
  ],

  fallback: FALLBACK,

  scenarios: [
    {
      name: 'collar recommended',
      inputs: input({ volatility: 0.15, protectionLevel: 0.2, tenorYears: 1 as any }),
      expect: { recommended: 'collar' },
      headlineMatches: PICK_COLLAR,
      answerRejects: [FALLBACK, PICK_PUT, PICK_SPREAD, PICK_NONE],
    },
    {
      name: 'protective put recommended',
      inputs: input({ volatility: 0.3, protectionLevel: 0.05, tenorYears: 2 as any }),
      expect: { recommended: 'protective-put' },
      headlineMatches: PICK_PUT,
      answerRejects: [FALLBACK, PICK_COLLAR, PICK_SPREAD, PICK_NONE],
    },
    {
      name: 'put spread recommended',
      // Collar caps too often (~49% under 20% drift) and the shallow 5% floor
      // makes the bare put expensive, but a 1-in-20 short strike leaves a wide,
      // cleanly-priced band - so the engine's clean pick is the spread.
      inputs: input({
        volatility: 0.3,
        protectionLevel: 0.05,
        tenorYears: 1 as any,
        expectedReturn: 0.2,
        spreadRiskLevel: 0.05,
      }),
      expect: { recommended: 'put-spread' },
      headlineMatches: PICK_SPREAD,
      answerRejects: [FALLBACK, PICK_PUT, PICK_COLLAR, PICK_NONE],
    },
    {
      name: 'neither recommended (none)',
      inputs: input({ volatility: 0.15, protectionLevel: 0.05, tenorYears: 1 as any }),
      expect: { recommended: 'none' },
      headlineMatches: PICK_NONE,
      answerRejects: [FALLBACK, PICK_PUT, PICK_COLLAR, PICK_SPREAD],
    },
  ],
};
