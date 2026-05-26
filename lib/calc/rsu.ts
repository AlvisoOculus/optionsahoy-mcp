// AlphaLatitude Inc. © 2026
//
// RSU Sell-vs-Hold Calculator orchestrator.
// Pure functions — no I/O, no state. Re-runs synchronously on input change.
//
// MODEL ASSUMPTIONS:
//   - Single-trigger RSUs that vest into freely-tradeable shares (public co.,
//     post-IPO). Double-trigger / pre-IPO liquidity events out of scope.
//   - At vest, vestValue = shares × FMV becomes W-2 ordinary income.
//   - FICA (SS + Medicare + Additional Medicare) applies when still employed.
//   - Sell-to-cover funding assumed: post-tax dollar exposure V is identical
//     for both paths. (Cash-fund splits this; not modeled — most RSU vesting
//     is net-settled.)
//   - Hold path: keep V dollars in single stock at FMV cost basis; sell at
//     T years. T < 1y → short-term (ordinary marginal); T ≥ 1y → LTCG + NIIT.
//   - Sell path: V in market at expected median return; pay LTCG/STCG on the
//     market gain at year T.
//   - Single state for both vest and sale year.
//   - NIIT (3.8%) applies to LTCG, not to vest income (which is W-2 wages).
//
// Shares the haircut + market-seed pattern with the NSO calc; see
// docs/revisions/ClaudeDesign_Revision_042.md.

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
import type { FilingStatus } from '@/lib/tax/types';
// Re-export the lognormal vol-drag mapping + chain-derived haircut so this
// module is the single import for the RSU calc UI. Math is identical to NSO.
export { lognormalHaircut, haircutFromChain } from '@/lib/calc/nso';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface RsuInput {
  shares: number;             // RSU shares vesting in this tranche
  currentPrice: number;       // FMV at vest = cost basis on retained shares
  ordinaryIncome: number;     // annual ordinary income BEFORE this vest
  filingStatus: FilingStatus;
  stateCode: string;
  stillEmployed: boolean;
  holdYears: number;          // 0.25..5; sub-1y triggers short-term tax cliff
  expectedSalePrice: number;  // $/share at year holdYears
  haircut: number;            // 0..1 vol drag on expectedSalePrice
  // Per-year MEDIAN market return rate. Slider seeds from SPY's trailing
  // CAGR with vol drag pre-applied (mirrors NSO calc).
  expectedMarketReturn: number;
}

export interface RsuTaxAtVest {
  vestValue: number;          // shares × currentPrice
  federal: number;
  state: number;
  socialSecurity: number;
  medicare: number;
  additionalMedicare: number;
  total: number;
  netCashAtVest: number;      // vestValue − total
  // IRS-mandated federal supplemental withholding at vest: 22% on the first
  // $1M of supplemental wages per year, 37% above. Often less than the true
  // marginal federal rate, leaving an under-withholding gap the user owes
  // at tax time.
  federalWithheldAtVest: number;
}

export interface BracketJump {
  fromRate: number;
  toRate: number;
  thresholdAtJump: number;
}

export interface RsuHoldStrategy {
  costBasis: number;          // = currentPrice (FMV at vest)
  effectiveSalePrice: number; // expectedSalePrice × (1 − haircut)
  sharesRetained: number;     // = netCashAtVest / currentPrice (sell-to-cover dollar-equiv)
  expectedGain: number;       // (effectiveSalePrice − costBasis) × sharesRetained
  capGainFederal: number;     // LTCG (incl. NIIT) if ≥1y else marginal
  capGainState: number;
  capGainTotal: number;
  isLongTerm: boolean;        // true iff holdYears ≥ 1
  netAtYearN: number;         // sale proceeds − capGainTotal
}

export interface RsuSellNowInvest {
  netCashAtY0: number;        // = netCashAtVest
  marketGain: number;
  capGainFederal: number;     // LTCG (incl. NIIT) if ≥1y else marginal
  capGainState: number;
  capGainTotal: number;
  isLongTerm: boolean;
  netAtYearN: number;
}

export interface RsuResult {
  vest: RsuTaxAtVest;
  bracketJump: BracketJump | null;
  hold: RsuHoldStrategy;
  sellNowInvest: RsuSellNowInvest;
  holdMinusSell: number;      // hold.netAtYearN − sellNowInvest.netAtYearN
}

// ---------------------------------------------------------------
// Tax at vest — W-2 ordinary + FICA on the full vestValue
// ---------------------------------------------------------------

export function computeTaxAtVest(input: RsuInput): RsuTaxAtVest {
  const vestValue = Math.max(0, input.shares * input.currentPrice);

  if (vestValue === 0) {
    return {
      vestValue: 0,
      federal: 0,
      state: 0,
      socialSecurity: 0,
      medicare: 0,
      additionalMedicare: 0,
      total: 0,
      netCashAtVest: 0,
      federalWithheldAtVest: 0,
    };
  }

  const federalSchedule = ORDINARY_2026[input.filingStatus];
  const fedBefore = walkOrdinaryBrackets(input.ordinaryIncome, federalSchedule);
  const fedAfter = walkOrdinaryBrackets(
    input.ordinaryIncome + vestValue,
    federalSchedule,
  );
  const federal = fedAfter - fedBefore;

  // RSU vest is W-2 wages — taxed at ordinary rates by every state. Reuse
  // computeStateGainTax with isLongTerm=false (matches the NSO bargain pattern).
  const state = computeStateGainTax({
    stateCode: input.stateCode,
    ordinaryIncome: input.ordinaryIncome,
    gainAmount: vestValue,
    isLongTerm: false,
    filingStatus: input.filingStatus,
  });

  const socialSecurity = input.stillEmployed
    ? socialSecurityTaxOnAddedWages(input.ordinaryIncome, vestValue)
    : 0;
  const medicare = input.stillEmployed
    ? medicareTaxOnAddedWages(vestValue)
    : 0;
  const additionalMedicare = input.stillEmployed
    ? additionalMedicareTaxOnAddedWages(
        input.ordinaryIncome,
        vestValue,
        input.filingStatus,
      )
    : 0;

  const total = federal + state + socialSecurity + medicare + additionalMedicare;
  const netCashAtVest = vestValue - total;

  // IRS supplemental wage withholding: 22% up to $1M per calendar year,
  // 37% on the portion above $1M. Treats this single vest as the year's
  // supplemental wages (a simplification — in reality the $1M bucket is
  // shared across all supplementals for the year).
  const SUPPLEMENTAL_THRESHOLD = 1_000_000;
  const federalWithheldAtVest =
    0.22 * Math.min(vestValue, SUPPLEMENTAL_THRESHOLD) +
    0.37 * Math.max(0, vestValue - SUPPLEMENTAL_THRESHOLD);

  return {
    vestValue,
    federal,
    state,
    socialSecurity,
    medicare,
    additionalMedicare,
    total,
    netCashAtVest,
    federalWithheldAtVest,
  };
}

// ---------------------------------------------------------------
// Bracket-jump detection — does this vest cross a federal bracket?
// ---------------------------------------------------------------

export function detectBracketJump(input: RsuInput): BracketJump | null {
  const vestValue = Math.max(0, input.shares * input.currentPrice);
  if (vestValue === 0) return null;

  const schedule = ORDINARY_2026[input.filingStatus];
  const totalIncome = input.ordinaryIncome + vestValue;

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

  return {
    fromRate: schedule[beforeIdx].rate,
    toRate: schedule[afterIdx].rate,
    thresholdAtJump: schedule[beforeIdx + 1].min,
  };
}

// ---------------------------------------------------------------
// Cap-gain helper: federal (incl. NIIT for LTCG) + state on a gain
// ---------------------------------------------------------------
//
// LTCG (≥1y): computeFederalGainTax handles 0/15/20 brackets + NIIT;
// computeStateGainTax handles state. Short-term (<1y): both helpers,
// passed isLongTerm=false, fall back to ordinary marginal rates. So a
// single function handles both regimes.

function capGainOnGain(
  input: RsuInput,
  gainAmount: number,
  isLongTerm: boolean,
): { federal: number; state: number; total: number } {
  if (gainAmount <= 0) return { federal: 0, state: 0, total: 0 };
  const args = {
    ordinaryIncome: input.ordinaryIncome,
    gainAmount,
    isLongTerm,
    filingStatus: input.filingStatus,
  };
  const federal = computeFederalGainTax(args);
  const state = computeStateGainTax({ ...args, stateCode: input.stateCode });
  return { federal, state, total: federal + state };
}

// ---------------------------------------------------------------
// Hold path — V dollars stays in single stock, sells at year T
// ---------------------------------------------------------------

export function computeHoldStrategy(
  input: RsuInput,
  vestTax: RsuTaxAtVest,
): RsuHoldStrategy {
  const holdYears = Math.max(0, input.holdYears);
  const isLongTerm = holdYears >= 1;
  const costBasis = input.currentPrice;
  const effectiveSalePrice = input.expectedSalePrice * (1 - input.haircut);
  // Sell-to-cover: post-tax dollar exposure equals netCashAtVest. The
  // equivalent share count at FMV is V / FMV.
  const sharesRetained =
    input.currentPrice > 0 ? vestTax.netCashAtVest / input.currentPrice : 0;
  const expectedGain = Math.max(
    0,
    (effectiveSalePrice - costBasis) * sharesRetained,
  );
  const grossProceeds = effectiveSalePrice * sharesRetained;
  const tax = capGainOnGain(input, expectedGain, isLongTerm);
  const netAtYearN = grossProceeds - tax.total;

  return {
    costBasis,
    effectiveSalePrice,
    sharesRetained,
    expectedGain,
    capGainFederal: tax.federal,
    capGainState: tax.state,
    capGainTotal: tax.total,
    isLongTerm,
    netAtYearN,
  };
}

// ---------------------------------------------------------------
// Sell-now path — V dollars goes to diversified market
// ---------------------------------------------------------------

export function computeSellNowInvest(
  input: RsuInput,
  vest: RsuTaxAtVest,
): RsuSellNowInvest {
  const holdYears = Math.max(0, input.holdYears);
  const isLongTerm = holdYears >= 1;
  const X = vest.netCashAtVest;
  const r = Math.max(0, input.expectedMarketReturn);
  const marketGain = X > 0 ? X * (Math.pow(1 + r, holdYears) - 1) : 0;
  const tax = capGainOnGain(input, marketGain, isLongTerm);
  return {
    netCashAtY0: X,
    marketGain,
    capGainFederal: tax.federal,
    capGainState: tax.state,
    capGainTotal: tax.total,
    isLongTerm,
    netAtYearN: X + marketGain - tax.total,
  };
}

// ---------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------

export function computeRsuResult(input: RsuInput): RsuResult {
  const vest = computeTaxAtVest(input);
  const bracketJump = detectBracketJump(input);
  const hold = computeHoldStrategy(input, vest);
  const sellNowInvest = computeSellNowInvest(input, vest);
  const holdMinusSell = hold.netAtYearN - sellNowInvest.netAtYearN;
  return { vest, bracketJump, hold, sellNowInvest, holdMinusSell };
}

// ---------------------------------------------------------------
// Bracket-breakdown rows for the tax-cell hovers (mirrors NSO)
// ---------------------------------------------------------------

export function rsuFederalBreakdownRows(input: RsuInput): TaxBreakdownRow[] {
  const vestValue = Math.max(0, input.shares * input.currentPrice);
  if (vestValue === 0) return [];
  const slices = sliceBracketsAcrossDelta(
    input.ordinaryIncome,
    vestValue,
    ORDINARY_2026[input.filingStatus],
  );
  return slices
    .filter((s) => s.tax > 0)
    .map((s) => ({ label: 'Federal', rate: s.rate, amount: s.amount, tax: s.tax }));
}

export function rsuStateBreakdownRows(input: RsuInput): TaxBreakdownRow[] {
  const vestValue = Math.max(0, input.shares * input.currentPrice);
  if (vestValue === 0) return [];
  const stateBrackets = getStateBrackets(input.stateCode, input.filingStatus, '2026');
  if (!stateBrackets) return [];
  const slices = sliceBracketsAcrossDelta(
    input.ordinaryIncome,
    vestValue,
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

// Bracket-walk rows for a SHORT-TERM cap gain (taxed at ordinary marginal).
// Walked over (ordinaryIncome, gainAmount) — no vest stacking, since the
// gain is realized in year N, not year 0.
export function rsuStcgFederalRows(
  input: RsuInput,
  gainAmount: number,
): TaxBreakdownRow[] {
  if (gainAmount <= 0) return [];
  const slices = sliceBracketsAcrossDelta(
    input.ordinaryIncome,
    gainAmount,
    ORDINARY_2026[input.filingStatus],
  );
  return slices
    .filter((s) => s.tax > 0)
    .map((s) => ({ label: 'Federal', rate: s.rate, amount: s.amount, tax: s.tax }));
}

export function rsuStcgStateRows(
  input: RsuInput,
  gainAmount: number,
): TaxBreakdownRow[] {
  if (gainAmount <= 0) return [];
  const stateBrackets = getStateBrackets(input.stateCode, input.filingStatus, '2026');
  if (!stateBrackets) return [];
  const slices = sliceBracketsAcrossDelta(
    input.ordinaryIncome,
    gainAmount,
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

// Re-export — NSO already provides a no-state-tax detector with the right
// semantics; the UI imports it from this module so the calc and UI share one
// source of truth on which sliders/columns to hide.
export { stateHasIncomeTax } from '@/lib/calc/nso';
