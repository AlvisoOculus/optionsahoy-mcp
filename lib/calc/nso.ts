// AlphaLatitude Inc. © 2026
//
// NSO Exercise Calculator orchestrator.
// Pure functions — no I/O, no state. Re-runs synchronously on input change.
//
// MODEL ASSUMPTIONS (matching docs/tools/nso-calculator-spec.md §10):
//   - NSOs do NOT generate AMT bargain element (federal § 421(b) does not
//     apply to NSOs). The calculator does not run AMT logic.
//   - Bargain element at exercise = (current price − strike) × shares,
//     treated as W-2 ordinary income for the holder if still employed.
//   - FICA (SS + Medicare + Additional Medicare) applies only when still
//     employed at exercise. Year-of-separation and deferred-comp wrinkles
//     are out of scope.
//   - Hold strategy: pay exercise tax in year 0, sell after ≥1 year for LTCG
//     treatment. Cost basis after exercise = current price (FMV at exercise).
//   - Single state for both exercise and sale year.
//   - NIIT (3.8%) applies to the LTCG sale, not to the exercise (bargain
//     element is W-2 wages, not investment income).

import {
  computeFederalGainTax,
  sliceBracketsAcrossDelta,
  walkOrdinaryBrackets,
} from '@/lib/tax/bracket-walker';
import type { TaxBreakdownRow } from '@/lib/calc/concentration';
import { computeStateGainTax } from '@/lib/tax/state-tax';
import { ORDINARY_2026 } from '@/lib/tax/federal-2026';
import {
  additionalMedicareTaxOnAddedWages,
  medicareTaxOnAddedWages,
  socialSecurityTaxOnAddedWages,
} from '@/lib/tax/fica-2026';
import { getStateBrackets } from '@/lib/tax/state-tax';
import type { TickerChain } from '@/lib/data/chains';
import type { FilingStatus } from '@/lib/tax/types';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface NsoInput {
  shares: number;             // NSO shares to exercise
  strike: number;             // $/share strike
  currentPrice: number;       // $/share current FMV / market price
  ordinaryIncome: number;     // annual ordinary income BEFORE the NSO exercise
  filingStatus: FilingStatus;
  stateCode: string;          // 2-letter
  stillEmployed: boolean;     // FICA applies only when true
  holdYears: number;          // ≥1; sub-1y is short-term and out of scope
  expectedSalePrice: number;
  haircut: number;            // 0..1
  // Per-year MEDIAN market return rate. Slider seeds from SPY's trailing CAGR
  // with vol drag pre-applied (see NsoCalculator.tsx); compounds via plain
  // (1+r)^T to give median terminal value directly.
  expectedMarketReturn: number;
  holdFunding: 'sell-to-cover' | 'cash';
}

export interface NsoTaxAtExercise {
  bargainElement: number;
  federal: number;
  state: number;
  socialSecurity: number;
  medicare: number;
  additionalMedicare: number;
  total: number;
  netCashSellAll: number;     // bargainElement − total
}

export interface BracketJump {
  fromRate: number;
  toRate: number;
  thresholdAtJump: number;
}

export interface HoldStrategy {
  funding: 'sell-to-cover' | 'cash';
  costBasis: number;
  strikeCost: number;
  cashNeededAtExercise: number;
  sharesSoldToCover: number;  // sell-to-cover only; 0 in cash mode
  sharesRetained: number;
  effectiveSalePrice: number;
  expectedGain: number;
  ltcgFederal: number;        // includes NIIT
  ltcgState: number;
  ltcgTotal: number;
  afterTaxProceedsAtSale: number;
  // Opportunity cost of y0 outflow Y = strikeCost + exerciseTax.total
  // (cash funding only; all four are 0 for sell-to-cover).
  y0OutflowGain: number;      // Y × ((1+r)^N − 1)
  y0OutflowLtcgFederal: number;
  y0OutflowLtcgState: number;
  y0OutflowLtcgTotal: number;
  y0OutflowForgoneNet: number; // = y0OutflowGain − y0OutflowLtcgTotal
  netAtYearN: number;
}

export interface SellNowInvest {
  netCashAtY0: number;
  marketGain: number;
  ltcgFederal: number;        // includes NIIT
  ltcgState: number;
  ltcgTotal: number;
  netAtYearN: number;
}

export interface NsoResult {
  exercise: NsoTaxAtExercise;
  bracketJump: BracketJump | null;
  hold: HoldStrategy;
  sellNowInvest: SellNowInvest;
  holdMinusCashless: number;  // hold.netAtYearN − sellNowInvest.netAtYearN
}

// ---------------------------------------------------------------
// Tax at exercise
// ---------------------------------------------------------------

export function computeTaxAtExercise(input: NsoInput): NsoTaxAtExercise {
  const bargainElement = Math.max(
    0,
    (input.currentPrice - input.strike) * input.shares,
  );

  if (bargainElement === 0) {
    return {
      bargainElement: 0,
      federal: 0,
      state: 0,
      socialSecurity: 0,
      medicare: 0,
      additionalMedicare: 0,
      total: 0,
      netCashSellAll: 0,
    };
  }

  // Federal marginal income tax on the bargain element (W-2 ordinary).
  const federalSchedule = ORDINARY_2026[input.filingStatus];
  const fedBefore = walkOrdinaryBrackets(input.ordinaryIncome, federalSchedule);
  const fedAfter = walkOrdinaryBrackets(
    input.ordinaryIncome + bargainElement,
    federalSchedule,
  );
  const federal = fedAfter - fedBefore;

  // State marginal: reuse computeStateGainTax with isLongTerm=false (taxes
  // the gain at ordinary rates, which is correct for NSO bargain element in
  // every state except WA — and WA doesn't tax NSO bargain element since
  // it's wages, not LTCG. computeStateGainTax returns 0 for WA short-term,
  // which is the right answer here too.)
  const state = computeStateGainTax({
    stateCode: input.stateCode,
    ordinaryIncome: input.ordinaryIncome,
    gainAmount: bargainElement,
    isLongTerm: false,
    filingStatus: input.filingStatus,
  });

  // FICA (only when still employed at exercise).
  const socialSecurity = input.stillEmployed
    ? socialSecurityTaxOnAddedWages(input.ordinaryIncome, bargainElement)
    : 0;
  const medicare = input.stillEmployed
    ? medicareTaxOnAddedWages(bargainElement)
    : 0;
  const additionalMedicare = input.stillEmployed
    ? additionalMedicareTaxOnAddedWages(
        input.ordinaryIncome,
        bargainElement,
        input.filingStatus,
      )
    : 0;

  const total = federal + state + socialSecurity + medicare + additionalMedicare;
  const netCashSellAll = bargainElement - total;

  return {
    bargainElement,
    federal,
    state,
    socialSecurity,
    medicare,
    additionalMedicare,
    total,
    netCashSellAll,
  };
}

// ---------------------------------------------------------------
// Bracket-jump detection
// ---------------------------------------------------------------

export function detectBracketJump(input: NsoInput): BracketJump | null {
  const bargainElement = Math.max(
    0,
    (input.currentPrice - input.strike) * input.shares,
  );
  if (bargainElement === 0) return null;

  const schedule = ORDINARY_2026[input.filingStatus];
  const totalIncome = input.ordinaryIncome + bargainElement;

  const findTopBracketIndex = (income: number): number => {
    let topIdx = 0;
    for (let i = 0; i < schedule.length; i++) {
      if (income > schedule[i].min) topIdx = i;
      else break;
    }
    return topIdx;
  };

  const beforeIdx = findTopBracketIndex(input.ordinaryIncome);
  const afterIdx = findTopBracketIndex(totalIncome);

  if (afterIdx === beforeIdx) return null;

  // The threshold at which the user crossed into the higher bracket.
  // That's the start of the bracket immediately above their pre-NSO position.
  return {
    fromRate: schedule[beforeIdx].rate,
    toRate: schedule[afterIdx].rate,
    thresholdAtJump: schedule[beforeIdx + 1].min,
  };
}

// ---------------------------------------------------------------
// LTCG helper — fed (incl. NIIT) + state on a long-term gain
// ---------------------------------------------------------------

function ltcgOnGain(
  input: NsoInput,
  gainAmount: number,
): { federal: number; state: number; total: number } {
  if (gainAmount <= 0) return { federal: 0, state: 0, total: 0 };
  const args = {
    ordinaryIncome: input.ordinaryIncome,
    gainAmount,
    isLongTerm: true,
    filingStatus: input.filingStatus,
  };
  const federal = computeFederalGainTax(args);
  const state = computeStateGainTax({ ...args, stateCode: input.stateCode });
  return { federal, state, total: federal + state };
}

// ---------------------------------------------------------------
// Hold-for-LTCG comparison
// ---------------------------------------------------------------

export function computeHoldStrategy(
  input: NsoInput,
  exerciseTax: NsoTaxAtExercise,
): HoldStrategy {
  const holdYears = Math.max(1, input.holdYears);
  const costBasis = input.currentPrice;
  const effectiveSalePrice = input.expectedSalePrice * (1 - input.haircut);
  const strikeCost = Math.max(0, input.strike * input.shares);
  const cashNeededAtExercise = strikeCost + exerciseTax.total;
  const funding = input.holdFunding;

  // Compute share counts and y0 cash flow per funding mode.
  let sharesSoldToCover = 0;
  let sharesRetained = input.shares;
  let y0Outflow = 0;
  if (funding === 'sell-to-cover') {
    sharesSoldToCover =
      input.currentPrice > 0
        ? Math.min(input.shares, cashNeededAtExercise / input.currentPrice)
        : 0;
    sharesRetained = Math.max(0, input.shares - sharesSoldToCover);
    y0Outflow = 0; // covered by share sale
  } else {
    // 'cash': pay strike + tax out of pocket; keep all N shares.
    sharesSoldToCover = 0;
    sharesRetained = input.shares;
    y0Outflow = cashNeededAtExercise;
  }

  const expectedGain = (effectiveSalePrice - costBasis) * sharesRetained;
  const grossProceeds = effectiveSalePrice * sharesRetained;

  const stockLtcg = ltcgOnGain(input, expectedGain);
  const afterTaxProceedsAtSale = grossProceeds - stockLtcg.total;

  // expectedMarketReturn is the per-year MEDIAN rate (vol-drag pre-applied at
  // seed time, see NsoCalculator.tsx). So plain compounding gives median
  // terminal value directly.
  // Sell-to-cover has y0Outflow = 0, so all four y0Outflow* fields roll to 0.
  const r = Math.max(0, input.expectedMarketReturn);
  const y0OutflowGain = y0Outflow * (Math.pow(1 + r, holdYears) - 1);
  const y0Ltcg = ltcgOnGain(input, y0OutflowGain);
  const y0OutflowForgoneNet = y0OutflowGain - y0Ltcg.total;

  const netAtYearN = afterTaxProceedsAtSale - y0Outflow - y0OutflowForgoneNet;

  return {
    funding,
    costBasis,
    strikeCost,
    cashNeededAtExercise,
    sharesSoldToCover,
    sharesRetained,
    effectiveSalePrice,
    expectedGain,
    ltcgFederal: stockLtcg.federal,
    ltcgState: stockLtcg.state,
    ltcgTotal: stockLtcg.total,
    afterTaxProceedsAtSale,
    y0OutflowGain,
    y0OutflowLtcgFederal: y0Ltcg.federal,
    y0OutflowLtcgState: y0Ltcg.state,
    y0OutflowLtcgTotal: y0Ltcg.total,
    y0OutflowForgoneNet,
    netAtYearN,
  };
}

export function computeSellNowInvest(
  input: NsoInput,
  exercise: NsoTaxAtExercise,
): SellNowInvest {
  const holdYears = Math.max(1, input.holdYears);
  const X = exercise.netCashSellAll;
  const r = Math.max(0, input.expectedMarketReturn);
  // r is the per-year median rate (vol-drag pre-applied at seed time).
  const marketGain = X > 0 ? X * (Math.pow(1 + r, holdYears) - 1) : 0;
  const ltcg = ltcgOnGain(input, marketGain);
  return {
    netCashAtY0: X,
    marketGain,
    ltcgFederal: ltcg.federal,
    ltcgState: ltcg.state,
    ltcgTotal: ltcg.total,
    netAtYearN: X + marketGain - ltcg.total,
  };
}

// ---------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------

export function computeNsoResult(input: NsoInput): NsoResult {
  const exercise = computeTaxAtExercise(input);
  const bracketJump = detectBracketJump(input);
  const hold = computeHoldStrategy(input, exercise);
  const sellNowInvest = computeSellNowInvest(input, exercise);
  const holdMinusCashless = hold.netAtYearN - sellNowInvest.netAtYearN;

  return {
    exercise,
    bracketJump,
    hold,
    sellNowInvest,
    holdMinusCashless,
  };
}

// State-bracket lookup helper — exported for the UI to detect "no-state-tax"
// states and conditionally hide the state line. (Avoids duplicating the
// no-income-tax check.)
export function stateHasIncomeTax(stateCode: string): boolean {
  const brackets = getStateBrackets(stateCode, 'single', '2026');
  if (!brackets) return false;
  // No-income-tax states have a single {min: 0, rate: 0}.
  return brackets.some((b) => b.rate > 0);
}

// ---------------------------------------------------------------
// Bracket-breakdown rows for the tax-cell hovers
// ---------------------------------------------------------------
//
// Slices the marginal walk over the bargain element across federal (and
// state) ordinary-income brackets. Returns one row per bracket the bargain
// touches, mirroring the AMT-ISO calculator's hover breakdown.

export function nsoFederalBreakdownRows(input: NsoInput): TaxBreakdownRow[] {
  const bargainElement = Math.max(
    0,
    (input.currentPrice - input.strike) * input.shares,
  );
  if (bargainElement === 0) return [];
  const slices = sliceBracketsAcrossDelta(
    input.ordinaryIncome,
    bargainElement,
    ORDINARY_2026[input.filingStatus],
  );
  return slices
    .filter((s) => s.tax > 0)
    .map((s) => ({ label: 'Federal', rate: s.rate, amount: s.amount, tax: s.tax }));
}

export function nsoStateBreakdownRows(input: NsoInput): TaxBreakdownRow[] {
  const bargainElement = Math.max(
    0,
    (input.currentPrice - input.strike) * input.shares,
  );
  if (bargainElement === 0) return [];
  const stateBrackets = getStateBrackets(input.stateCode, input.filingStatus, '2026');
  if (!stateBrackets) return [];
  const slices = sliceBracketsAcrossDelta(
    input.ordinaryIncome,
    bargainElement,
    stateBrackets,
  );
  return slices
    .filter((s) => s.tax > 0)
    .map((s) => ({
      label: input.stateCode,
      rate: s.rate,
      amount: s.amount,
      tax: s.tax,
    }));
}

// ---------------------------------------------------------------
// Volatility-derived haircut
// ---------------------------------------------------------------
//
// Maps annualized volatility σ + horizon T (years) to a deterministic
// "concentration haircut" applied to the user's expected sale price.
//
// Implementation lives in `lib/calc/volatility-drag.ts` so the ISO and other
// projection-based calculators can share the chain-IV extraction. Re-exported
// here for back-compat with existing call sites in NsoCalculator/RsuSellVsHold/
// NsoHoldPeriodChart.
import { chainAtmImpliedVol, lognormalHaircut } from './volatility-drag';
export { chainAtmImpliedVol, lognormalHaircut };

/**
 * Compute a haircut from a ticker chain: average call+put implied vol at
 * (ATM, holdYears), then apply the lognormal mapping. Returns null when the
 * chain has no usable cells (rare — the surface usually has at least one).
 */
export function haircutFromChain(
  chain: TickerChain,
  holdYears: number,
  today: Date = new Date(),
): number | null {
  const sigma = chainAtmImpliedVol(chain, holdYears, today);
  if (sigma === null) return null;
  return lognormalHaircut(sigma, holdYears);
}
