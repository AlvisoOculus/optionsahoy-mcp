// AlphaLatitude Inc. © 2026
//
// QSBS (Section 1202) qualification engine. Takes a structured set of facts
// about a stock holding and returns a verdict, the applicable exclusion
// percentage, dollar cap, and federal tax savings.
//
// Three eras under §1202, based on the stock's acquisition date:
//
//   (1) Aug 11, 1993 – Feb 17, 2009: 50% exclusion at 5+ year hold,
//       with a 7% AMT preference on the excluded portion.
//   (2) Feb 18, 2009 – Sep 27, 2010: 75% exclusion at 5+ year hold,
//       with a 7% AMT preference on the excluded portion.
//   (3) Sep 28, 2010 – Jul 4, 2025: 100% exclusion at 5+ year hold,
//       no AMT preference.
//   (4) Jul 5, 2025 and later (OBBBA): tiered exclusion — 50% at 3+ yrs,
//       75% at 4+ yrs, 100% at 5+ yrs. Per-issuer cap raised from $10M
//       to $15M; aggregate gross asset ceiling raised from $50M to $75M.
//       Both new caps are indexed for inflation beginning in 2027. No
//       AMT preference at any tier.

import type { FilingStatus } from '@/lib/tax';

// Era cutoffs as UTC dates so the comparison is timezone-stable.
const OBBBA_CUTOFF = Date.UTC(2025, 6, 4); // 2025-07-04 (exclusive on the start; >2025-07-04 → new regime)
const FULL_EXCLUSION_CUTOFF = Date.UTC(2010, 8, 27); // 2010-09-27 (acquisitions after → 100%)
const PARTIAL_75_CUTOFF = Date.UTC(2009, 1, 17); // 2009-02-17 (acquisitions after → 75% era)
const QSBS_INCEPTION = Date.UTC(1993, 7, 10); // 1993-08-10 (acquisitions after → §1202 era)

// Federal LTCG + NIIT effective rate used for tax-saved estimates. We use
// the top-bracket rate (20% + 3.8% NIIT) — anyone modeling a $1M+ gain is
// almost certainly there at point of sale. Less than ideal for marginal
// cases but rounds to a number a user can sanity-check.
const FED_LTCG_NIIT_RATE = 0.238;

// States that do NOT conform to §1202 (taxpayer owes state tax on the
// federally excluded gain). California eliminated conformity in 2013.
// Alabama, Mississippi, and Pennsylvania never conformed.
//
// New Jersey is handled separately below: NJ enacted §1202 conformity in
// 2025 for tax years beginning on or after Jan 1, 2026, so the answer
// depends on the sale date.
//
// Hawaii partially conforms (50% exclusion only, even when federal allows
// 100%). Massachusetts has limited / partial conformity with §1202.
//
// Sources: Lexology / Frost Brown Todd, Keystone Global Partners 2026
// state map, Cullen and Dykman on the NJ change.
const NON_CONFORMING_STATES: ReadonlySet<string> = new Set([
  'CA',
  'AL',
  'PA',
  'MS',
]);

const PARTIAL_CONFORMING_STATES: ReadonlySet<string> = new Set([
  'HI',
  'MA',
]);

// New Jersey conforms to §1202 (including OBBBA enhancements) for tax
// years beginning on or after this date. Sales before the cutoff still
// owe NJ state tax on the federally excluded gain.
const NJ_CONFORMITY_CUTOFF = Date.UTC(2026, 0, 1);

export type QsbsEntityType = 'us-c-corp' | 'other';

export type QsbsAcquisitionMethod =
  | 'original-issuance'
  | 'gift-or-inheritance'
  | 'secondary'
  | 'unsure';

export type QsbsAssetCategory =
  | 'under-50m'
  | '50m-to-75m'
  | 'over-75m'
  | 'unsure';

export type QsbsIndustry =
  | 'tech-software'
  | 'manufacturing'
  | 'biotech-research'
  | 'retail-wholesale'
  | 'health-services'
  | 'law'
  | 'engineering'
  | 'architecture'
  | 'accounting-actuarial'
  | 'consulting'
  | 'finance'
  | 'farming'
  | 'extraction'
  | 'hospitality'
  | 'performing-arts'
  | 'other-services'
  | 'unsure';

export const QSBS_INDUSTRY_OPTIONS: { value: QsbsIndustry; label: string; qualifies: boolean | 'ambiguous' }[] = [
  { value: 'tech-software', label: 'Software / SaaS / internet', qualifies: true },
  { value: 'manufacturing', label: 'Manufacturing / hardware', qualifies: true },
  { value: 'biotech-research', label: 'Biotech R&D / drug development', qualifies: true },
  { value: 'retail-wholesale', label: 'Retail / wholesale / e-commerce', qualifies: true },
  { value: 'health-services', label: 'Health services', qualifies: false },
  { value: 'law', label: 'Law', qualifies: false },
  { value: 'engineering', label: 'Engineering services', qualifies: false },
  { value: 'architecture', label: 'Architecture services', qualifies: false },
  { value: 'accounting-actuarial', label: 'Accounting / actuarial science', qualifies: false },
  { value: 'consulting', label: 'Consulting', qualifies: false },
  { value: 'finance', label: 'Financial services / banking / insurance', qualifies: false },
  { value: 'farming', label: 'Farming', qualifies: false },
  { value: 'extraction', label: 'Oil, gas, or mineral extraction', qualifies: false },
  { value: 'hospitality', label: 'Hotel / motel / restaurant', qualifies: false },
  { value: 'performing-arts', label: 'Performing arts / athletics', qualifies: false },
  { value: 'other-services', label: 'Other services', qualifies: 'ambiguous' },
  { value: 'unsure', label: 'Not sure', qualifies: 'ambiguous' },
];

export interface QsbsInputs {
  acquisitionDate: Date;
  saleDate: Date;
  entityType: QsbsEntityType;
  acquisitionMethod: QsbsAcquisitionMethod;
  assetCategory: QsbsAssetCategory;
  industry: QsbsIndustry;
  activeBusiness: 'yes' | 'no' | 'unsure';
  adjustedBasis: number;
  expectedGain: number;
  stateCode: string;
  ordinaryIncome: number;
  filingStatus: FilingStatus;
}

export type QsbsVerdict =
  | 'qualifies'
  | 'partial'
  | 'too-soon'
  | 'caveats'
  | 'disqualified';

export type QsbsTestStatus = 'pass' | 'fail' | 'unsure' | 'wait';

export interface QsbsTestResult {
  id: string;
  label: string;
  status: QsbsTestStatus;
  detail: string;
}

export type QsbsExclusionPercent = 0 | 0.5 | 0.75 | 1.0;

export interface QsbsResult {
  verdict: QsbsVerdict;
  exclusionPercent: QsbsExclusionPercent;
  perIssuerCap: number;
  tenXBasisCap: number;
  applicableCap: number;
  excludableGain: number;
  taxableGain: number;
  federalTaxSaved: number;
  stateConforms: 'full' | 'partial' | 'none';
  stateNote?: string;
  holdingYears: number;
  yearsUntilFullExclusion: number;
  era: 'pre-2009' | 'pre-2010' | 'pre-obbba' | 'obbba';
  tests: QsbsTestResult[];
}

// Calendar-aware year diff. Anchors on the start's month/day, counts whole
// anniversaries up to `end`, then adds the fractional remainder. Naive
// ms / (365.25 * day) reports 2022-01-01 → 2027-01-01 as 4.9986 years
// (5 calendar years contain only 1 leap day, not 1.25), which silently
// robs users at the exact-5-year boundary the §1202 hold check sits on.
function yearsBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  let years = end.getFullYear() - start.getFullYear();
  const anniversary = new Date(start);
  anniversary.setFullYear(start.getFullYear() + years);
  if (anniversary.getTime() > end.getTime()) {
    years -= 1;
    anniversary.setFullYear(start.getFullYear() + years);
  }
  const nextAnniversary = new Date(anniversary);
  nextAnniversary.setFullYear(anniversary.getFullYear() + 1);
  const fracMs = end.getTime() - anniversary.getTime();
  const fullYearMs = nextAnniversary.getTime() - anniversary.getTime();
  return years + fracMs / fullYearMs;
}

// Strip time-of-day from a Date and return a UTC midnight timestamp for the
// same calendar day. Era cutoffs are written as `Date.UTC(yyyy, mm, dd)` —
// also midnight — so this lets us compare date-to-date without the
// DatePicker's noon-UTC default falsely tipping a boundary day (e.g.,
// July 4, 2025) into the post-cutoff era.
function dateOnlyMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function classifyEra(acquisitionDate: Date): QsbsResult['era'] {
  const day = dateOnlyMs(acquisitionDate);
  if (day > OBBBA_CUTOFF) return 'obbba';
  if (day > FULL_EXCLUSION_CUTOFF) return 'pre-obbba';
  if (day > PARTIAL_75_CUTOFF) return 'pre-2010';
  return 'pre-2009';
}

// What exclusion % does this stock get at this holding period?
function exclusionForEra(era: QsbsResult['era'], holdingYears: number): QsbsExclusionPercent {
  if (era === 'obbba') {
    if (holdingYears >= 5) return 1.0;
    if (holdingYears >= 4) return 0.75;
    if (holdingYears >= 3) return 0.5;
    return 0;
  }
  // Pre-OBBBA eras: must hold 5 years for any exclusion.
  if (holdingYears < 5) return 0;
  if (era === 'pre-obbba') return 1.0;
  if (era === 'pre-2010') return 0.75;
  return 0.5;
}

// Years remaining until the stock would hit its top-tier exclusion (100%
// in OBBBA, 100%/75%/50% in earlier eras). Used to surface "hold N more
// months" guidance when the verdict is too-soon.
function yearsUntilFullExclusion(era: QsbsResult['era'], holdingYears: number): number {
  if (era === 'obbba') return Math.max(0, 5 - holdingYears);
  return Math.max(0, 5 - holdingYears);
}

function perIssuerCapForEra(era: QsbsResult['era']): number {
  return era === 'obbba' ? 15_000_000 : 10_000_000;
}

function assetTestPasses(category: QsbsAssetCategory, era: QsbsResult['era']): QsbsTestStatus {
  if (category === 'unsure') return 'unsure';
  if (era === 'obbba') {
    // $75M cap.
    if (category === 'over-75m') return 'fail';
    return 'pass';
  }
  // Pre-OBBBA: $50M cap.
  if (category === 'under-50m') return 'pass';
  return 'fail';
}

function industryTestPasses(industry: QsbsIndustry): QsbsTestStatus {
  const opt = QSBS_INDUSTRY_OPTIONS.find((o) => o.value === industry);
  if (!opt) return 'unsure';
  if (opt.qualifies === true) return 'pass';
  if (opt.qualifies === false) return 'fail';
  return 'unsure';
}

function entityTestPasses(entity: QsbsEntityType): QsbsTestStatus {
  return entity === 'us-c-corp' ? 'pass' : 'fail';
}

function acquisitionTestPasses(method: QsbsAcquisitionMethod): QsbsTestStatus {
  if (method === 'original-issuance' || method === 'gift-or-inheritance') return 'pass';
  if (method === 'secondary') return 'fail';
  return 'unsure';
}

function activeBusinessTest(answer: 'yes' | 'no' | 'unsure'): QsbsTestStatus {
  if (answer === 'yes') return 'pass';
  if (answer === 'no') return 'fail';
  return 'unsure';
}

function stateConformity(
  stateCode: string,
  saleDate: Date,
): { conforms: 'full' | 'partial' | 'none'; note?: string } {
  // New Jersey: non-conforming for sales before 2026-01-01, conforming for
  // sales in tax years 2026 and beyond (NJ adopted §1202, including OBBBA
  // enhancements, in 2025).
  if (stateCode === 'NJ') {
    if (dateOnlyMs(saleDate) >= NJ_CONFORMITY_CUTOFF) {
      return { conforms: 'full' };
    }
    return {
      conforms: 'none',
      note:
        'New Jersey did not conform to §1202 for tax years before 2026 — full gain taxable at the state level. (NJ now conforms for sales in 2026+.)',
    };
  }

  if (NON_CONFORMING_STATES.has(stateCode)) {
    const labels: Record<string, string> = {
      CA: 'California does not conform to §1202',
      AL: 'Alabama does not conform to §1202',
      PA: 'Pennsylvania does not conform to §1202',
      MS: 'Mississippi does not conform to §1202',
    };
    return {
      conforms: 'none',
      note: `${labels[stateCode]} — your full gain is taxable at the state level.`,
    };
  }
  if (PARTIAL_CONFORMING_STATES.has(stateCode)) {
    const labels: Record<string, string> = {
      HI: 'Hawaii allows only a 50% exclusion, even when federal law allows 100%.',
      MA: 'Massachusetts has limited conformity with §1202 — state benefit can be smaller than federal. Check state guidance.',
    };
    return {
      conforms: 'partial',
      note: labels[stateCode] ?? `${stateCode} partially conforms to §1202 — check state-specific rules.`,
    };
  }
  return { conforms: 'full' };
}

export function evaluateQsbs(inputs: QsbsInputs): QsbsResult {
  const era = classifyEra(inputs.acquisitionDate);
  const holdingYears = Math.max(0, yearsBetween(inputs.acquisitionDate, inputs.saleDate));
  const yearsToFull = yearsUntilFullExclusion(era, holdingYears);
  const eraExclusion = exclusionForEra(era, holdingYears);

  // Run each qualification test.
  const tests: QsbsTestResult[] = [];

  const entityStatus = entityTestPasses(inputs.entityType);
  tests.push({
    id: 'entity',
    label: 'US C-corporation',
    status: entityStatus,
    detail:
      inputs.entityType === 'us-c-corp'
        ? 'C-corps qualify. S-corps, LLCs, partnerships, and foreign entities do not.'
        : 'Only US C-corporations issue QSBS. S-corps, LLCs, and partnerships are excluded.',
  });

  const acquisitionStatus = acquisitionTestPasses(inputs.acquisitionMethod);
  tests.push({
    id: 'original-issuance',
    label: 'Original-issuance acquisition',
    status: acquisitionStatus,
    detail:
      inputs.acquisitionMethod === 'original-issuance'
        ? 'Stock acquired directly from the company qualifies.'
        : inputs.acquisitionMethod === 'gift-or-inheritance'
          ? 'Gift or inheritance tacks onto the original holder\'s status and holding period.'
          : inputs.acquisitionMethod === 'secondary'
            ? 'Secondary-market purchases don\'t qualify — must come from the issuer.'
            : 'Confirm whether you bought directly from the company at issuance.',
  });

  const assetStatus = assetTestPasses(inputs.assetCategory, era);
  const assetCap = era === 'obbba' ? '$75M' : '$50M';
  tests.push({
    id: 'asset-cap',
    label: `Gross assets ≤ ${assetCap} at issuance`,
    status: assetStatus,
    detail:
      assetStatus === 'pass'
        ? `Issuer was under the ${assetCap} aggregate gross-assets ceiling.`
        : assetStatus === 'fail'
          ? `Issuer exceeded ${assetCap}. The cap is measured at the time you got the stock.`
          : `If you don\'t know, check the company\'s 409A or board materials for total assets at the round you bought into.`,
  });

  const industryStatus = industryTestPasses(inputs.industry);
  tests.push({
    id: 'industry',
    label: 'Qualified trade or business',
    status: industryStatus,
    detail:
      industryStatus === 'pass'
        ? 'Software, manufacturing, biotech R&D, retail, and similar trades qualify.'
        : industryStatus === 'fail'
          ? '§1202(e)(3) excludes health, law, engineering, architecture, accounting, actuarial, consulting, financial services, brokerage, banking, insurance, farming, extraction, hospitality, and performing-arts businesses — plus any business where the principal asset is the reputation or skill of its employees.'
          : 'Borderline — services-heavy businesses get scrutinized, especially where the principal asset is employee reputation or skill. Ask a tax pro.',
  });

  const activeStatus = activeBusinessTest(inputs.activeBusiness);
  tests.push({
    id: 'active-business',
    label: '80% of assets in active business',
    status: activeStatus,
    detail:
      activeStatus === 'pass'
        ? 'At least 80% of corporate assets used in the qualified active trade.'
        : activeStatus === 'fail'
          ? 'Investment-heavy balance sheets break this test — too much cash or portfolio securities.'
          : 'This is usually fine for operating startups but worth confirming.',
  });

  // Holding-period test is separate — we report it last so the verdict
  // logic below can distinguish "too soon" from "disqualified".
  const minimumHoldingYears = era === 'obbba' ? 3 : 5;
  const holdingPassesAny = holdingYears >= minimumHoldingYears;
  tests.push({
    id: 'holding',
    label:
      era === 'obbba'
        ? 'Held at least 3 years (50%) / 4 (75%) / 5 (100%)'
        : 'Held at least 5 years',
    status: holdingPassesAny ? 'pass' : 'wait',
    detail: holdingPassesAny
      ? `${holdingYears.toFixed(1)} years held — ${(eraExclusion * 100).toFixed(0)}% exclusion tier.`
      : `${holdingYears.toFixed(1)} years held. ${yearsToFull.toFixed(1)} years until the 100% tier.`,
  });

  // Hard-fail tests collapse everything to disqualified.
  const hardFail = tests.some((t) => t.status === 'fail');
  const hasUnsure = tests.some((t) => t.status === 'unsure');

  let verdict: QsbsVerdict;
  let appliedExclusion: QsbsExclusionPercent;

  if (hardFail) {
    verdict = 'disqualified';
    appliedExclusion = 0;
  } else if (!holdingPassesAny) {
    verdict = 'too-soon';
    appliedExclusion = 0;
  } else if (hasUnsure) {
    verdict = 'caveats';
    appliedExclusion = eraExclusion;
  } else if (eraExclusion === 1.0) {
    verdict = 'qualifies';
    appliedExclusion = 1.0;
  } else {
    verdict = 'partial';
    appliedExclusion = eraExclusion;
  }

  const perIssuerCap = perIssuerCapForEra(era);
  const tenXBasisCap = inputs.adjustedBasis * 10;
  const applicableCap = Math.max(perIssuerCap, tenXBasisCap);
  const cappedGain = Math.min(Math.max(0, inputs.expectedGain), applicableCap);
  const excludableGain = appliedExclusion * cappedGain;
  const taxableGain = Math.max(0, inputs.expectedGain - excludableGain);
  const federalTaxSaved = excludableGain * FED_LTCG_NIIT_RATE;

  const stateConf = stateConformity(inputs.stateCode, inputs.saleDate);

  return {
    verdict,
    exclusionPercent: appliedExclusion,
    perIssuerCap,
    tenXBasisCap,
    applicableCap,
    excludableGain,
    taxableGain,
    federalTaxSaved,
    stateConforms: stateConf.conforms,
    stateNote: stateConf.note,
    holdingYears,
    yearsUntilFullExclusion: yearsToFull,
    era,
    tests,
  };
}
