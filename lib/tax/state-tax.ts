// AlphaLatitude Inc. © 2026
//
// State income tax. The bracket schedules live in ./states/*.json; how each
// state gets from income to state taxable income (its starting point,
// deductions, exemptions, credits, add-ons and capital gain rules) lives in
// ./state-rules.ts. The calculators pass FEDERAL taxable income; everything
// here converts from that.

import type { Bracket, FilingStatus, StateTaxData } from './types';
import { computeNiit, sliceBracketsAcrossDelta, walkLtcgFederal, walkOrdinaryBrackets } from './bracket-walker';
import { LTCG_2026, ORDINARY_2026, STANDARD_DEDUCTION_2026, agiFromTaxableIncome } from './federal-2026';
import { STATE_RULES_2026, type StateTaxContext } from './state-rules';

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

// Read the bracket schedule for a state + tax year, with HoH fallback to
// single. Returns null for no-income-tax / unknown states.
export function getStateBrackets(
  stateCode: string,
  filingStatus: FilingStatus,
  taxYear: '2025' | '2026' = '2026',
): Bracket[] | null {
  const stateData = STATES[stateCode];
  if (!stateData) return null;
  const yearData = stateData.years[taxYear] ?? stateData.years['2025'];
  if (!yearData) return null;
  const brackets = yearData[filingStatus] ?? yearData.single ?? [];
  return brackets.length > 0 ? brackets : null;
}

/** The state's rate schedule applied to STATE taxable income (no deductions, credits or add-ons). */
export function stateScheduleTax(
  stateCode: string,
  stateTaxableIncome: number,
  filingStatus: FilingStatus,
  taxYear: '2025' | '2026' = '2026',
): number {
  const brackets = getStateBrackets(stateCode, filingStatus, taxYear);
  return brackets ? walkOrdinaryBrackets(Math.max(0, stateTaxableIncome), brackets) : 0;
}

// ---------------------------------------------------------------
// stateIncomeTax: one state return for one scenario
// ---------------------------------------------------------------

export interface StateTaxScenario {
  stateCode: string;
  filingStatus: FilingStatus;
  /** Federal taxable income before the event priced here (the calculator input). */
  ordinaryIncome: number;
  /** The event, all of it in federal AGI: W-2 income, short- and long-term gain. */
  wages?: number;
  shortTermGain?: number;
  longTermGain?: number;
}

export interface StateTaxResult {
  /** Federal AGI used for the state's phaseouts (taxable income + standard deduction + event). */
  agi: number;
  taxableIncome: number;
  /** Rate-schedule tax (or the state's own tax function), plus add-ons, before credits. */
  taxBeforeCredits: number;
  credits: number;
  tax: number;
  /**
   * The regular tax a state's AMT form compares against: tax before credits,
   * without California's 1% behavioral health tax (Schedule P line 25 is
   * Form 540 line 31; that tax is on line 62).
   */
  amtComparator: number;
}

const ZERO: StateTaxResult = { agi: 0, taxableIncome: 0, taxBeforeCredits: 0, credits: 0, tax: 0, amtComparator: 0 };

export function stateIncomeTax(s: StateTaxScenario): StateTaxResult {
  const rules = STATE_RULES_2026[s.stateCode];
  if (!rules) return ZERO;
  const status = s.filingStatus;
  const wages = Math.max(0, s.wages ?? 0);
  const shortTermGain = Math.max(0, s.shortTermGain ?? 0);
  const longTermGain = Math.max(0, s.longTermGain ?? 0);
  const baseTi = Math.max(0, s.ordinaryIncome);

  // Federal figures the state rules key off.
  const federalOrdinary = baseTi + wages + shortTermGain;
  const federalTaxableIncome = federalOrdinary + longTermGain;
  const federalIncomeTax =
    walkOrdinaryBrackets(federalOrdinary, ORDINARY_2026[status]) +
    walkLtcgFederal(federalOrdinary, longTermGain, LTCG_2026[status]);
  const ctx: StateTaxContext = {
    status,
    agi: agiFromTaxableIncome(baseTi, status) + wages + shortTermGain + longTermGain,
    federalTaxableIncome,
    federalStandardDeduction: STANDARD_DEDUCTION_2026[status],
    longTermGain,
    shortTermGain,
    federalIncomeTax,
    federalNiit: computeNiit(baseTi + wages, shortTermGain + longTermGain, status),
  };

  const start = rules.start === 'federal_taxable_income' ? federalTaxableIncome : ctx.agi;
  const taxableIncome = Math.max(
    0,
    start +
      (rules.additions?.(ctx) ?? 0) -
      (rules.subtractions?.(ctx) ?? 0) -
      (rules.standardDeduction?.(ctx) ?? 0) -
      (rules.exemptionDeduction?.(ctx) ?? 0) -
      (rules.federalTaxDeduction?.(ctx) ?? 0),
  );
  const schedule = (x: number) => stateScheduleTax(s.stateCode, x, status);
  const base = rules.tax ? rules.tax(taxableIncome, ctx, schedule) : schedule(taxableIncome);
  const taxBeforeCredits = base + (rules.addOns?.(taxableIncome, ctx) ?? 0);
  const credits = Math.min(taxBeforeCredits, rules.credits?.(taxableIncome, ctx) ?? 0);
  const behavioralHealthTax = s.stateCode === 'CA' ? 0.01 * Math.max(0, taxableIncome - 1_000_000) : 0;
  return {
    agi: ctx.agi,
    taxableIncome,
    taxBeforeCredits,
    credits,
    tax: taxBeforeCredits - credits,
    amtComparator: taxBeforeCredits - behavioralHealthTax,
  };
}

// ---------------------------------------------------------------
// computeStateGainTax
// ---------------------------------------------------------------
// Returns the MARGINAL state tax on a sale or on added W-2 income: the extra
// dollars owed because of it, computed as the difference between two full
// state returns so every deduction phaseout and add-on it crosses is counted.
// Washington is the special case (LTCG-only flat tax).

export function computeStateGainTax(args: {
  stateCode: string;
  ordinaryIncome: number;
  gainAmount: number;
  isLongTerm: boolean;
  filingStatus: FilingStatus;
  /**
   * Ordinary income (wages, an NSO spread, an RSU vest, interest) rather than
   * a short-term capital gain. The two differ in some states: Massachusetts
   * taxes short-term gains at 8.5% and Missouri exempts capital gains.
   */
  isOrdinaryIncome?: boolean;
}): number {
  const { stateCode, ordinaryIncome, gainAmount, isLongTerm, filingStatus, isOrdinaryIncome = false } = args;

  if (gainAmount <= 0) return 0;

  // WA: 7% LTCG-only tax, only on LONG-TERM gains, only above the threshold.
  if (stateCode === 'WA') {
    if (!isLongTerm) return 0;
    const taxable = Math.max(0, gainAmount - WA_LTCG_THRESHOLD_2026);
    return taxable * WA_LTCG_RATE;
  }

  const base = { stateCode, filingStatus, ordinaryIncome };
  const event = isLongTerm
    ? { longTermGain: gainAmount }
    : isOrdinaryIncome
      ? { wages: gainAmount }
      : { shortTermGain: gainAmount };
  return stateIncomeTax({ ...base, ...event }).tax - stateIncomeTax(base).tax;
}

// ---------------------------------------------------------------
// Breakdown rows for the calculators' tax-cell hovers
// ---------------------------------------------------------------

export interface StateBreakdownRow {
  label: string;
  rate: number;
  amount: number;
  tax: number;
  detail?: string;
}

/**
 * The state tax on `event` (or, with no event, the whole state tax on the
 * base income) as bracket slices of STATE taxable income, plus one row for
 * whatever the brackets alone do not explain: deductions phasing out,
 * add-ons such as a recapture or surtax, and credits. The rows always sum to
 * the tax the engine charges.
 */
export function stateTaxBreakdownRows(
  base: StateTaxScenario,
  event?: Pick<StateTaxScenario, 'wages' | 'shortTermGain' | 'longTermGain'>,
): StateBreakdownRow[] {
  const brackets = getStateBrackets(base.stateCode, base.filingStatus);
  if (!brackets || !STATE_RULES_2026[base.stateCode]) return [];
  const before = stateIncomeTax(base);
  const after = event ? stateIncomeTax({ ...base, ...event }) : before;
  const from = event ? before.taxableIncome : 0;
  const total = event ? after.tax - before.tax : before.tax;
  const rows: StateBreakdownRow[] = sliceBracketsAcrossDelta(from, after.taxableIncome - from, brackets)
    .filter((sl) => sl.tax > 0)
    .map((sl) => ({ label: base.stateCode, rate: sl.rate, amount: sl.amount, tax: sl.tax }));
  const residual = total - rows.reduce((sum, r) => sum + r.tax, 0);
  if (Math.abs(residual) >= 0.5) {
    rows.push({
      label: `${base.stateCode} adjustments`,
      rate: 0,
      amount: 0,
      tax: residual,
      detail: 'deductions, add-ons and credits',
    });
  }
  return rows;
}
