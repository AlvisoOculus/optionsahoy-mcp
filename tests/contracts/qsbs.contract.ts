// AlphaLatitude Inc. © 2026
//
// QSBS answer contract. Drives evaluateQsbs -> headline('qsbs_check', result)
// across every verdict the engine can return, and binds the rendered answer to
// the engine's numbers. QSBS spans the most criticals across the bot, docs, and
// resource layers (see docs/agent-output-defects-2026-06-24.md), so it is the
// first contract built.

import { evaluateQsbs, type QsbsInputs, type QsbsResult } from '@/lib/calc/qsbs';
import { headline } from '../../functions/poe';
import type { ToolContract } from './contract-types';

// A complete, qualifying baseline. Scenarios clone this and perturb the one
// field that drives the verdict under test.
function base(overrides: Partial<QsbsInputs> = {}): QsbsInputs {
  return {
    acquisitionDate: new Date('2018-01-01'),
    saleDate: new Date('2026-06-01'),
    entityType: 'us-c-corp',
    acquisitionMethod: 'original-issuance',
    assetCategory: 'under-50m',
    industry: 'tech-software',
    activeBusiness: 'yes',
    adjustedBasis: 100_000,
    expectedGain: 5_000_000,
    stateCode: 'CA',
    ordinaryIncome: 250_000,
    filingStatus: 'single',
    ...overrides,
  };
}

const REJECT_CAP_PARENTHETICAL = /capped at \$[\d,]+ per company|per-company exclusion cap/;
const FALLBACK = /does not appear to qualify/;

export const qsbsContract: ToolContract<QsbsInputs, QsbsResult> = {
  tool: 'qsbs_check',
  run: (inputs) => evaluateQsbs(inputs),
  format: (result) => headline('qsbs_check', result as any),

  requiredFacts: [
    {
      name: 'exclusion percent shown',
      applies: (r) => typeof r.exclusionPercent === 'number' && r.exclusionPercent > 0,
      present: (t) => /\b\d{1,3}% of the gain/.test(t),
    },
    {
      name: 'excludable gain shown',
      applies: (r) => typeof r.excludableGain === 'number' && r.excludableGain > 0,
      present: (t) => /shields about \$[\d,]+ of gain/.test(t),
    },
    {
      name: 'federal tax saved shown',
      applies: (r) => typeof r.federalTaxSaved === 'number' && r.federalTaxSaved > 0,
      present: (t) => /saving roughly \$[\d,]+ in federal tax/.test(t),
    },
    {
      name: 'taxable gain shown',
      applies: (r) => typeof r.taxableGain === 'number' && r.taxableGain > 0,
      present: (t) => /\$[\d,]+ of gain stays taxable/.test(t),
    },
    {
      name: 'blocking test named when disqualified by a hard fail',
      applies: (r) => Array.isArray(r.tests) && r.tests.some((x: any) => x.status === 'fail'),
      present: (t) => /What is blocking it:/.test(t),
    },
    {
      name: 'state non-conformity surfaced',
      applies: (r) => r.stateConforms === 'none' && typeof r.stateNote === 'string',
      present: (t) => /not conform|taxable at the state level/i.test(t),
    },
    {
      name: 'genuine cap overage explained',
      applies: (r) => typeof r.cappedOverageNote === 'string' && r.cappedOverageNote.length > 0,
      present: (t) => REJECT_CAP_PARENTHETICAL.test(t) || /exceeds the Section 1202 exclusion cap/.test(t),
    },
  ],

  discriminants: [
    {
      field: 'verdict',
      values: ['qualifies', 'partial', 'too-soon', 'caveats', 'disqualified'],
      read: (r) => String(r.verdict),
    },
  ],

  fallback: FALLBACK,
  allowFallbackFor: ['verdict:disqualified'],

  scenarios: [
    {
      // Pre-OBBBA stock held 8+ years, every test passes, gain within the cap.
      name: 'qualifies (100%, within cap)',
      inputs: base(),
      expect: { verdict: 'qualifies' },
      headlineMatches: /Good news.*qualifies for the QSBS gain exclusion/,
      answerRejects: [FALLBACK, /partially qualifies/, /on track to qualify/, REJECT_CAP_PARENTHETICAL],
    },
    {
      // OBBBA stock held ~4.1 years -> 75% tier, every test passes. The taxable
      // remainder is a tier haircut, NOT a cap overage: no cap parenthetical.
      name: 'partial (OBBBA 75% tier)',
      inputs: base({ acquisitionDate: new Date('2025-08-01'), saleDate: new Date('2029-09-15') }),
      expect: { verdict: 'partial' },
      headlineMatches: /partially qualifies/,
      answerRejects: [FALLBACK, /Good news/, REJECT_CAP_PARENTHETICAL],
    },
    {
      // OBBBA stock held <3 years -> nothing excluded yet, but on track.
      name: 'too-soon (under the 3-year floor)',
      inputs: base({ acquisitionDate: new Date('2025-08-01'), saleDate: new Date('2027-06-01') }),
      expect: { verdict: 'too-soon' },
      headlineMatches: /on track to qualify/,
      answerRejects: [FALLBACK, REJECT_CAP_PARENTHETICAL],
    },
    {
      // Every hard test passes and the hold is met, but acquisition method is
      // unsure -> 'caveats'. Exclusion still applies, so the body claims a
      // shield. The headline must NOT say it does not qualify (P2).
      name: 'caveats (qualifies with items to confirm)',
      inputs: base({ acquisitionMethod: 'unsure' }),
      expect: { verdict: 'caveats' },
      headlineMatches: /likely qualifies for the QSBS gain exclusion/,
      answerRejects: [FALLBACK],
    },
    {
      // Non-C-corp -> hard fail -> disqualified. Nothing excluded; the full gain
      // is taxable because it does not qualify, NOT because of the cap (P9).
      name: 'disqualified (non C-corp)',
      inputs: base({ entityType: 'other' }),
      expect: { verdict: 'disqualified' },
      headlineMatches: FALLBACK,
      answerRejects: [/Good news/, /partially qualifies/, REJECT_CAP_PARENTHETICAL],
    },
    {
      // Qualifies but the gain genuinely tops the $10M cap: the overage IS the
      // reason a chunk stays taxable, so the cap explanation SHOULD appear.
      name: 'cap overage (qualifies, gain over cap)',
      inputs: base({ expectedGain: 20_000_000 }),
      expect: { verdict: 'qualifies' },
      headlineMatches: /Good news.*qualifies/,
      answerRejects: [FALLBACK],
    },
  ],
};
