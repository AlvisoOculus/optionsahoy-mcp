// AlphaLatitude Inc. © 2026
//
// State tax: loads the right state JSON, walks the brackets,
// handles the WA LTCG-only wrinkle.

import type { FilingStatus, StateTaxData } from './types';
import { walkOrdinaryBrackets } from './bracket-walker';

// All state JSONs, eagerly imported. Total payload ~70KB raw, far less gzipped.
// If bundle size becomes a concern, switch to dynamic import keyed on state code.
import AK from './states/AK.json';
import AL from './states/AL.json';
import AR from './states/AR.json';
import AZ from './states/AZ.json';
import CA from './states/CA.json';
import CO from './states/CO.json';
import CT from './states/CT.json';
import DC from './states/DC.json';
import DE from './states/DE.json';
import FL from './states/FL.json';
import GA from './states/GA.json';
import HI from './states/HI.json';
import IA from './states/IA.json';
import ID from './states/ID.json';
import IL from './states/IL.json';
import IN from './states/IN.json';
import KS from './states/KS.json';
import KY from './states/KY.json';
import LA from './states/LA.json';
import MA from './states/MA.json';
import MD from './states/MD.json';
import ME from './states/ME.json';
import MI from './states/MI.json';
import MN from './states/MN.json';
import MO from './states/MO.json';
import MS from './states/MS.json';
import MT from './states/MT.json';
import NC from './states/NC.json';
import ND from './states/ND.json';
import NE from './states/NE.json';
import NH from './states/NH.json';
import NJ from './states/NJ.json';
import NM from './states/NM.json';
import NV from './states/NV.json';
import NY from './states/NY.json';
import OH from './states/OH.json';
import OK from './states/OK.json';
import OR from './states/OR.json';
import PA from './states/PA.json';
import RI from './states/RI.json';
import SC from './states/SC.json';
import SD from './states/SD.json';
import TN from './states/TN.json';
import TX from './states/TX.json';
import UT from './states/UT.json';
import VA from './states/VA.json';
import VT from './states/VT.json';
import WA from './states/WA.json';
import WI from './states/WI.json';
import WV from './states/WV.json';
import WY from './states/WY.json';

export const STATES: Record<string, StateTaxData> = {
  AK, AL, AR, AZ, CA, CO, CT, DC, DE, FL, GA, HI, IA, ID, IL, IN, KS, KY, LA,
  MA, MD, ME, MI, MN, MO, MS, MT, NC, ND, NE, NH, NJ, NM, NV, NY, OH, OK, OR,
  PA, RI, SC, SD, TN, TX, UT, VA, VT, WA, WI, WV, WY,
} as unknown as Record<string, StateTaxData>;

export const STATE_CODES = Object.keys(STATES).sort();

export const STATE_OPTIONS = STATE_CODES.map((code) => ({
  code,
  name: STATES[code].name,
}));

// Washington's dedicated 7% LTCG-only tax (RCW 82.87).
// Threshold is statutory and increased to $270k for tax year 2026 (was $262k for 2025).
// Source: WA Department of Revenue, capital gains tax FAQ.
const WA_LTCG_RATE = 0.07;
const WA_LTCG_THRESHOLD_2026 = 270_000;

// States that tax LTCG at preferential rates (vs. ordinary income). Applied
// only when isLongTerm=true. Most states tax LTCG as ordinary income — those
// states are NOT in this map and fall through to the default bracket walk.
//
// Sources:
//   HI — HRS §235-71(c): alternative tax election, capped at 7.25%.
//   ND — NDCC §57-38-01.1(11): 40% subtraction of net LTCG.
//   SC — SC Code §12-6-1150: 44% deduction of net LTCG.
//   WI — WI Stat §71.05(6)(b)(9): 30% exclusion of net LTCG (60% farm; not modeled).
//   AR — Act 819 of 2015: first $10K of net LTCG fully taxable, 50% exclusion above.
//   NM — NMSA §7-2-34: greater of $1,000 or 40% of net LTCG excluded.
type StateLtcgRule =
  | { kind: 'effectiveCap'; cap: number }                                 // HI
  | { kind: 'exclusion'; fraction: number }                               // ND, SC, WI
  | { kind: 'thresholdExclusion'; threshold: number; fractionAbove: number } // AR
  | { kind: 'maxExclusion'; floor: number; fraction: number };            // NM

const STATE_LTCG_RULES: Record<string, StateLtcgRule> = {
  HI: { kind: 'effectiveCap', cap: 0.0725 },
  ND: { kind: 'exclusion', fraction: 0.40 },
  SC: { kind: 'exclusion', fraction: 0.44 },
  WI: { kind: 'exclusion', fraction: 0.30 },
  AR: { kind: 'thresholdExclusion', threshold: 10_000, fractionAbove: 0.50 },
  NM: { kind: 'maxExclusion', floor: 1_000, fraction: 0.40 },
};

function applyLtcgExclusion(rule: StateLtcgRule, gainAmount: number): number {
  switch (rule.kind) {
    case 'exclusion':
      return gainAmount * (1 - rule.fraction);
    case 'thresholdExclusion':
      return (
        Math.min(rule.threshold, gainAmount) +
        (1 - rule.fractionAbove) * Math.max(0, gainAmount - rule.threshold)
      );
    case 'maxExclusion': {
      const exclusion = Math.max(rule.floor, gainAmount * rule.fraction);
      return Math.max(0, gainAmount - exclusion);
    }
    case 'effectiveCap':
      return gainAmount; // Cap is applied to the tax, not the taxable amount.
  }
}

// Read the bracket schedule for a state + tax year, with HoH fallback to
// single. Returns null for no-income-tax / unknown states.
export function getStateBrackets(
  stateCode: string,
  filingStatus: FilingStatus,
  taxYear: '2025' | '2026' = '2026',
): import('./types').Bracket[] | null {
  const stateData = STATES[stateCode];
  if (!stateData) return null;
  const yearData = stateData.years[taxYear] ?? stateData.years['2025'];
  if (!yearData) return null;
  const brackets = yearData[filingStatus] ?? yearData.single ?? [];
  return brackets.length > 0 ? brackets : null;
}

// ---------------------------------------------------------------
// computeStateGainTax
// ---------------------------------------------------------------
// Returns the MARGINAL state tax on a sale: the extra dollars
// owed because of the gain.
// Most states tax LTCG as ordinary income — same brackets.
// Washington is the special case (LTCG-only flat tax).

export function computeStateGainTax(args: {
  stateCode: string;
  ordinaryIncome: number;
  gainAmount: number;
  isLongTerm: boolean;
  filingStatus: FilingStatus;
  taxYear?: '2025' | '2026';
}): number {
  const { stateCode, ordinaryIncome, gainAmount, isLongTerm, filingStatus, taxYear = '2026' } = args;

  if (gainAmount <= 0) return 0;

  // WA: 7% LTCG-only tax, only on LONG-TERM gains, only above the threshold.
  if (stateCode === 'WA') {
    if (!isLongTerm) return 0;
    const taxable = Math.max(0, gainAmount - WA_LTCG_THRESHOLD_2026);
    return taxable * WA_LTCG_RATE;
  }

  const stateData = STATES[stateCode];
  if (!stateData) return 0;

  const yearData = stateData.years[taxYear] ?? stateData.years['2025'];
  if (!yearData) return 0;

  // Some states' JSONs omit head_household; fall back to single (the IRS
  // and most state schedules use the single brackets for HoH at this scale).
  const brackets = yearData[filingStatus] ?? yearData.single ?? [];
  if (brackets.length === 0) return 0;

  // No-income-tax states: brackets contain a single {min: 0, rate: 0}.
  // The walker handles that correctly (returns 0).

  const taxWithout = walkOrdinaryBrackets(ordinaryIncome, brackets);

  // States with preferential LTCG rules (long-term only).
  const ltcgRule = isLongTerm ? STATE_LTCG_RULES[stateCode] : undefined;
  if (ltcgRule) {
    const taxableGain = applyLtcgExclusion(ltcgRule, gainAmount);
    const ordinaryWay =
      walkOrdinaryBrackets(ordinaryIncome + taxableGain, brackets) - taxWithout;
    if (ltcgRule.kind === 'effectiveCap') {
      return Math.min(ordinaryWay, gainAmount * ltcgRule.cap);
    }
    return ordinaryWay;
  }

  const taxWithGain = walkOrdinaryBrackets(ordinaryIncome + gainAmount, brackets);
  return taxWithGain - taxWithout;
}
