// AlphaLatitude Inc. © 2026
//
// Pure functions for walking progressive tax brackets. No state, no I/O.

import type { Bracket, FilingStatus, Brackets } from './types';
import { LTCG_2026, ORDINARY_2026, NIIT_RATE, NIIT_THRESHOLDS } from './federal-2026';

// One slice of tax: a chunk of dollars taxed at a single bracket rate.
// Used for breakdowns/tooltips so the user can see exactly which bracket
// each dollar fell into.
export type BracketSlice = {
  rate: number;     // e.g. 0.15
  amount: number;   // dollars in this slice
  tax: number;      // amount × rate
  bracketStart: number;
  bracketEnd: number; // Infinity for the top bracket
};

// Walk added dollars from cursor=startIncome across a progressive bracket
// schedule, returning one slice per bracket the dollars touched. Sum of
// slice.tax equals the marginal tax on the added amount.
export function sliceBracketsAcrossDelta(
  startIncome: number,
  addedAmount: number,
  brackets: Bracket[],
): BracketSlice[] {
  if (addedAmount <= 0) return [];
  const slices: BracketSlice[] = [];
  let remaining = addedAmount;
  let cursor = Math.max(0, startIncome);

  for (let i = 0; i < brackets.length; i++) {
    if (remaining <= 0) break;
    const bracketStart = brackets[i].min;
    const bracketEnd = i + 1 < brackets.length ? brackets[i + 1].min : Infinity;
    if (cursor >= bracketEnd) continue;
    const fillStart = Math.max(cursor, bracketStart);
    const room = bracketEnd - fillStart;
    const fill = Math.min(remaining, room);
    if (fill > 0) {
      slices.push({
        rate: brackets[i].rate,
        amount: fill,
        tax: fill * brackets[i].rate,
        bracketStart,
        bracketEnd,
      });
    }
    remaining -= fill;
    cursor = fillStart + fill;
  }
  return slices;
}

// ---------------------------------------------------------------
// walkOrdinaryBrackets
// ---------------------------------------------------------------
// Standard progressive walk: returns the total tax owed on `income`
// given a bracket schedule of ascending {min, rate} pairs.
//
// Brackets are interpreted as: rate applies from `min` up to the
// next bracket's `min` (or infinity for the top bracket).

export function walkOrdinaryBrackets(income: number, brackets: Bracket[]): number {
  if (income <= 0) return 0;

  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const start = brackets[i].min;
    const end = i + 1 < brackets.length ? brackets[i + 1].min : Infinity;
    const rate = brackets[i].rate;

    if (income <= start) break;

    const taxableInBracket = Math.min(income, end) - start;
    tax += taxableInBracket * rate;
  }

  return tax;
}

// ---------------------------------------------------------------
// walkLtcgFederal
// ---------------------------------------------------------------
// LTCG stacks ON TOP of ordinary income. The 0/15/20% bracket
// boundaries refer to total AGI (ordinary + LTCG), not LTCG alone.
//
// Example (single, 2026):
//   ordinary = $40k, ltcg = $20k
//   First $9,650 of LTCG fills the 0% bracket (49,650 - 40,000)
//   Next $10,350 falls in the 15% bracket
//   Total fed LTCG tax = $1,552.50

export function walkLtcgFederal(
  ordinaryIncome: number,
  ltcgAmount: number,
  brackets: Bracket[],
): number {
  if (ltcgAmount <= 0) return 0;

  let tax = 0;
  let remaining = ltcgAmount;
  let cursor = Math.max(0, ordinaryIncome);

  for (let i = 0; i < brackets.length; i++) {
    if (remaining <= 0) break;

    const bracketStart = brackets[i].min;
    const bracketEnd = i + 1 < brackets.length ? brackets[i + 1].min : Infinity;
    const rate = brackets[i].rate;

    if (cursor >= bracketEnd) continue;

    const fillStart = Math.max(cursor, bracketStart);
    const room = bracketEnd - fillStart;
    const fill = Math.min(remaining, room);

    tax += fill * rate;
    remaining -= fill;
    cursor = fillStart + fill;
  }

  return tax;
}

// ---------------------------------------------------------------
// computeNiit
// ---------------------------------------------------------------
// Net Investment Income Tax: 3.8% on the LESSER of:
//   (a) investment income (we use the LTCG amount as a proxy here)
//   (b) (AGI − threshold)
// Returns 0 when AGI is at or below the filing-status threshold.

export function computeNiit(
  ordinaryIncome: number,
  investmentIncome: number,
  filingStatus: FilingStatus,
): number {
  if (investmentIncome <= 0) return 0;

  const agi = ordinaryIncome + investmentIncome;
  const threshold = NIIT_THRESHOLDS[filingStatus];

  if (agi <= threshold) return 0;

  const taxable = Math.min(investmentIncome, agi - threshold);
  return taxable * NIIT_RATE;
}

// ---------------------------------------------------------------
// computeFederalGainTax
// ---------------------------------------------------------------
// One-shot entry point for federal tax on a sale (long- or short-term).
// Long-term: walks the LTCG brackets stacked on ordinary income, plus NIIT.
// Short-term: gain is taxed as ordinary income; NIIT still applies above threshold.
// Returns the MARGINAL tax — the extra dollars owed because of the gain
// (not the user's full federal tax bill).

export function computeFederalGainTax(args: {
  ordinaryIncome: number;
  gainAmount: number;
  isLongTerm: boolean;
  filingStatus: FilingStatus;
}): number {
  const { ordinaryIncome, gainAmount, isLongTerm, filingStatus } = args;

  if (gainAmount <= 0) return 0;

  let baseTax: number;
  if (isLongTerm) {
    baseTax = walkLtcgFederal(ordinaryIncome, gainAmount, LTCG_2026[filingStatus]);
  } else {
    // Short-term: marginal ordinary income tax
    const ordinarySchedule = ORDINARY_2026[filingStatus];
    const taxWithGain = walkOrdinaryBrackets(ordinaryIncome + gainAmount, ordinarySchedule);
    const taxWithout = walkOrdinaryBrackets(ordinaryIncome, ordinarySchedule);
    baseTax = taxWithGain - taxWithout;
  }

  const niit = computeNiit(ordinaryIncome, gainAmount, filingStatus);
  return baseTax + niit;
}
