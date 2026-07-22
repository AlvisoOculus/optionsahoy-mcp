// AlphaLatitude Inc. © 2026
//
// Equity-funding plan. Given a target after-tax dollar amount and a
// target date, finds the schedule of stock-lot sales that nets the
// target by the date with the most wealth remaining at the deadline.
// Multi-stack: one or more tickers, each with its own current price,
// growth assumption, and cost-basis lots of already-vested shares.
//
// Objective: maximize (target-date wealth) = (compounded after-tax cash
// from each sale × cash-interest growth factor to target date) + (value
// of leftover shares at projected target-date price), subject to
// cumulative after-tax cash (in target-date dollars) ≥ target. When the
// cash-interest rate is zero the objective collapses to minimize total
// taxes (federal LTCG/ordinary + state + NIIT) for a fixed gross need.
//
// Algorithm: bracket-aware greedy. For each (year, month, lot) candidate
// cell, repeatedly commit the block with the highest future-value per
// share — (gross − incremental tax) × growth factor / shares — refining
// 100 → 10 → 1 share blocks. Continues until target hit or inventory
// exhausted. Not a true DP — for single-stack scenarios the loss vs the
// true optimum stays within 1-2%; runtime is O(shares × periods × lots).
//
// Out of scope: FICA (no wage events here — sales of already-vested
// shares don't trigger FICA) and AMT (no ISO exercises). Multi-stack
// joint optimization is supported (one ticker per stack, each with its
// own price + growth assumption). Price drift across the horizon IS
// modeled via per-stack `expectedAnnualGrowth` plugged into projectPrice
// at each scheduled sale date.

import { walkOrdinaryBrackets } from '../tax/bracket-walker';
import { computeStateGainTax } from '../tax/state-tax';
import { ORDINARY_2026 } from '../tax/federal-2026';
import type { FilingStatus } from '../tax/types';
import {
  flattenStacks,
  isLongTermFor,
  marginalTaxForBlock,
  commitBlock,
  computeYearGainTax,
  projectPrice,
} from './lotSelector';
import type { FlatLot, YearState, PeriodState, LotInventory } from './lotSelector';

// projectPrice, isLongTermFor, marginalTaxForBlock, commitBlock, the
// flatten helper, and the FlatLot/YearState/PeriodState/LotInventory types
// moved to ./lotSelector in the RSU-lot-order phase-1 extraction. projectPrice
// is re-exported so existing importers (EquityFundingCalculator) are unaffected.
export { projectPrice };

export interface EquityFundingLot {
  shares: number;
  costBasisPerShare: number;
  acquisitionDate: Date;
  /**
   * Optional unvested-RSU marker. When set, the lot is an RSU tranche that
   * vests on this date. The calc treats acquisitionDate = vestDate and
   * overrides costBasisPerShare with the stack's projected price on the
   * vest date (RSU basis = FMV at vest). The lot is excluded from sales
   * in any candidate year whose sale date precedes vestDate.
   *
   * Vest-year ordinary-income tax on the RSU itself is NOT modeled here
   * (would distort the W-2 baseline used for LTCG bracket lookups). The
   * UI flags this caveat.
   */
  vestDate?: Date;
}

/**
 * One equity position (one ticker / company). Multiple stacks may be
 * supplied to plan a multi-position liquidation.
 */
export interface EquityFundingStack {
  /** Optional display label; doesn't affect math. */
  ticker?: string;
  currentPrice: number;
  /** See EquityFundingInput.expectedAnnualGrowth. */
  expectedAnnualGrowth?: number;
  /**
   * Optional per-stack annualized volatility override (σ, e.g. 0.45).
   * Comparison-only: consumed by computeEquityFundingComparison via
   * `stackVolatilities` to drive the lognormal shortfall model. The core
   * computeEquityFundingPlan ignores it (the median schedule carries no
   * price-uncertainty term). When unset, the comparison uses the chain-
   * resolved implied vol if a ticker is set, else `defaultVolatility`.
   */
  volatilityOverride?: number;
  lots: EquityFundingLot[];
}

export interface EquityFundingInput {
  targetAfterTax: number;
  targetDate: Date;
  /**
   * Multi-stack input (v1.7+). When `stacks` is provided, the legacy
   * top-level `lots` / `currentPrice` / `expectedAnnualGrowth` fields
   * are ignored.
   */
  stacks?: EquityFundingStack[];
  /**
   * Legacy single-stack input (v1.5 / v1.6). Auto-promoted to a single
   * stack at compute time. Provide either `stacks` (v1.7+) or these
   * three fields (legacy) — not both.
   */
  lots?: EquityFundingLot[];
  currentPrice?: number;
  /**
   * Annual expected stock-price growth as a decimal (0.10 = 10%/yr).
   * Defaults to 0 (constant-price assumption, matches v1.5 behavior).
   * The projected price at each future sale date is
   * `currentPrice × (1 + expectedAnnualGrowth)^Δyears`. Negative values
   * model a decline scenario.
   */
  expectedAnnualGrowth?: number;
  ordinaryIncome: number;
  filingStatus: FilingStatus;
  stateCode: string;
  /**
   * Annualized risk-free rate at which net cash from each sale earns
   * interest between the sale date and the target deadline. Models the
   * "money market" the proceeds sit in. Default 0 (interest ignored);
   * UI passes a real number like 0.04 so Lock-in-now's cash benefits
   * properly. Used in wealth-at-target and shortfall calcs alike.
   */
  cashInterestRate?: number;
  /**
   * Optional reference "now" — defaults to new Date(). Tests pass an
   * explicit value to keep year-classification deterministic.
   */
  today?: Date;
  /**
   * Restrict candidate sale years to this set. Used to produce the
   * Lock-in-now (current year only) and Hold-for-growth (target year
   * only) corner plans. When undefined, all years from today to target
   * are candidates.
   */
  restrictToSaleYears?: number[];
  /**
   * Override the sale date used for the current calendar year. Default
   * is Dec 31. Set to `today` to model "sell now at known prices" — the
   * Lock-in-now plan uses this so its realized cash is deterministic.
   * The override is ADDED to the current year's monthly periods unless
   * `useOnlyOverridePeriod` is also set (Lock-in-now uses both).
   */
  saleDateOverrideForCurrentYear?: Date;
  /**
   * When set with `saleDateOverrideForCurrentYear`, the current year is
   * collapsed to JUST the override period (no monthly EOMs added) — used
   * by Lock-in-now so it's a single deterministic sale on today. Hybrid
   * plans leave this off so phase 2 has monthly periods to spread into.
   */
  useOnlyOverridePeriod?: boolean;
  /**
   * Two-phase hybrid. Until cumulative net cash hits this amount, the
   * greedy is restricted to current-year sales (use with
   * saleDateOverrideForCurrentYear=today so the lock-in is deterministic).
   * After the threshold, the greedy uses all candidate years normally.
   *
   * The comparison sweep varies this from 0 (= Balanced, no lock-in) up
   * to targetAfterTax (= Lock-in-now, full lock-in), producing a smooth
   * frontier between the two corners.
   */
  lockInNowMinCash?: number;
  /**
   * When true, the greedy actively distributes phase-2 sales across all
   * available sale periods (monthly buckets) instead of piling them at
   * whichever period has the highest projected price. Each period gets a
   * roughly equal share of the after-lock-in goal; this is what makes
   * Balanced a real dollar-cost-averaging spread rather than a single
   * sale on the target date. Hold-for-growth deliberately leaves this
   * off so it keeps the "one big late sale" behavior.
   */
  spreadEvenlyAcrossPeriods?: boolean;
}

export interface SaleEntry {
  /** Index into the input's `stacks` array. Single-stack inputs always 0. */
  stackIndex: number;
  /** Optional ticker echoed from the stack, for display. */
  ticker?: string;
  /** Index into the stack's `lots` array. */
  lotIndex: number;
  shares: number;
  grossProceeds: number;
  gainAmount: number;
  isLongTerm: boolean;
  federalTax: number;
  stateTax: number;
  niit: number;
  netCash: number;
}

export interface YearSchedule {
  year: number;
  saleDateISO: string;
  sales: SaleEntry[];
  yearGrossProceeds: number;
  yearTotalTax: number;
  yearNetCash: number;
  runningCumulativeNet: number;
}

export interface EquityFundingResult {
  feasible: boolean;
  targetAfterTax: number;
  targetDateISO: string;
  totalAfterTaxAchieved: number;
  totalSharesSold: number;
  totalGrossProceeds: number;
  totalTaxes: {
    federal: number;
    state: number;
    niit: number;
    total: number;
  };
  schedule: YearSchedule[];
  comparison: {
    sellAllInTargetYearTotalTax: number;
    sellAllInTargetYearAfterTax: number;
    optimizedSavingsVsTargetYearSale: number;
    optimizedSavingsPct: number;
  };
  remainingShares: number;
  remainingPositionValue: number;
  /** After-tax value of liquidating all retained shares at the target date,
   *  computed by running them through the same tax engine the scheduled
   *  sales used (incremental fed + state + NIIT on top of the target year's
   *  end-of-plan accumulator). Used as the cash backstop in the shortfall
   *  calculation: if scheduled sales come in light, the user can sell the
   *  retained shares to cover, but pays tax on the gain. */
  remainingPositionAfterTax: number;
  /** Per-stack after-tax retained value, parallel to input.stacks. Used by
   *  the shortfall variance weighting so each stack's retained shares
   *  contribute their own σ²×t to the dollar-weighted average. */
  remainingNetByStack: number[];
  shortfall?: {
    maxAchievableAfterTax: number;
    gap: number;
  };
}

// Sale boundary per candidate year. For non-target years the sale defaults
// to Dec 31; for the target year it's targetDate itself. The current year
// can be overridden (Lock-in-now uses this with today's date so realized
// price equals projected price — no time uncertainty).
function saleDateForYear(
  year: number,
  targetDate: Date,
  today: Date,
  currentYearOverride?: Date,
): Date {
  // The override takes precedence even when the current year is also the
  // target year — Lock-in-now and hybrid lock-ins must always sell TODAY,
  // not on the target date that happens to fall in the same year.
  if (currentYearOverride && year === today.getUTCFullYear()) {
    return new Date(currentYearOverride);
  }
  if (year === targetDate.getUTCFullYear()) return new Date(targetDate);
  return new Date(Date.UTC(year, 11, 31));
}

// Cash interest is taxed as ordinary income each year, so the nominal rate
// the user enters overstates what actually compounds. This returns the
// effective after-tax rate by subtracting the user's marginal federal +
// state ordinary rate at their stated income. Probe with a $1k step; both
// federal and state schedules are piecewise-linear so the local slope is
// exact within a bracket.
function effectiveAfterTaxCashRate(
  nominalRate: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): number {
  if (nominalRate <= 0) return nominalRate;
  const dx = 1000;
  const fedTaxNow = walkOrdinaryBrackets(ordinaryIncome, ORDINARY_2026[filingStatus]);
  const fedTaxPlus = walkOrdinaryBrackets(ordinaryIncome + dx, ORDINARY_2026[filingStatus]);
  const fedMarginal = (fedTaxPlus - fedTaxNow) / dx;
  // computeStateGainTax with isLongTerm=false treats the input as ordinary
  // income — which is what interest income is. Sidesteps the state-LTCG
  // preferential paths.
  const stateDelta = computeStateGainTax({
    stateCode,
    ordinaryIncome,
    gainAmount: dx,
    isLongTerm: false,
    filingStatus,
  });
  const stateMarginal = stateDelta / dx;
  const marginal = Math.min(0.99, fedMarginal + stateMarginal);
  return nominalRate * (1 - marginal);
}

// Normalize either input shape (v1.5/v1.6 single-stack at top level OR
// v1.7+ explicit `stacks`) into the v1.7 form.
function normalizeStacks(input: EquityFundingInput): EquityFundingStack[] {
  if (input.stacks !== undefined) {
    if (input.stacks.length === 0) {
      throw new Error('field "stacks" must be a non-empty array');
    }
    return input.stacks;
  }
  if (input.lots !== undefined && input.currentPrice !== undefined) {
    return [
      {
        currentPrice: input.currentPrice,
        expectedAnnualGrowth: input.expectedAnnualGrowth,
        lots: input.lots,
      },
    ];
  }
  throw new Error(
    'EquityFundingInput requires either `stacks` (v1.7+) or legacy `lots` + `currentPrice`',
  );
}

function enumerateYears(today: Date, targetDate: Date): number[] {
  const startYear = today.getUTCFullYear();
  const endYear = targetDate.getUTCFullYear();
  if (endYear < startYear) {
    throw new Error('targetDate is before today');
  }
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y += 1) years.push(y);
  return years;
}

// Sale dates per year. Each year gets one entry per calendar month between
// (the start of the window) and (the end of the window for that year), so
// Balanced can spread sales across many monthly buckets rather than betting
// everything on a single Dec-31 / target-date sale. Same-year sales share
// the year's tax brackets via the YearState that owns them.
//
// Rules:
//   - For the CURRENT year: start from today's month. If a sale-date
//     override is set (Lock-in-now / hybrid lock-in phase), the current
//     year collapses to just that override date — phase 1 sells happen
//     exactly today, not at month-ends.
//   - For middle years: 12 month-end dates.
//   - For the TARGET year: month-ends up to (but not past) the target
//     date, plus the target date itself as the final period.
function enumerateSaleDatesByYear(
  today: Date,
  targetDate: Date,
  currentYearOverride?: Date,
  useOnlyOverridePeriod?: boolean,
): { year: number; saleDates: Date[] }[] {
  const startYear = today.getUTCFullYear();
  const endYear = targetDate.getUTCFullYear();
  if (endYear < startYear) throw new Error('targetDate is before today');
  const result: { year: number; saleDates: Date[] }[] = [];
  const HALF_DAY_MS = 12 * 60 * 60 * 1000;
  for (let y = startYear; y <= endYear; y += 1) {
    const dates: Date[] = [];
    const hasOverride = y === startYear && currentYearOverride !== undefined;
    if (hasOverride) {
      dates.push(new Date(currentYearOverride!));
      if (useOnlyOverridePeriod) {
        result.push({ year: y, saleDates: dates });
        continue;
      }
    }
    const firstMonth = y === startYear ? today.getUTCMonth() : 0;
    const lastMonth = y === endYear ? targetDate.getUTCMonth() : 11;
    for (let m = firstMonth; m <= lastMonth; m += 1) {
      const eom = new Date(Date.UTC(y, m + 1, 0));
      if (eom.getTime() < today.getTime()) continue;
      if (eom.getTime() > targetDate.getTime()) continue;
      // Deduplicate: skip if the EOM coincides with the override date.
      if (
        hasOverride &&
        Math.abs(eom.getTime() - currentYearOverride!.getTime()) < HALF_DAY_MS
      ) {
        continue;
      }
      dates.push(eom);
    }
    if (y === endYear) {
      const last = dates[dates.length - 1];
      if (!last || last.getTime() !== targetDate.getTime()) {
        dates.push(new Date(targetDate));
      }
    }
    if (dates.length > 0) result.push({ year: y, saleDates: dates });
  }
  return result;
}

// Hypothetical liquidation of every retained lot at target date, layered
// onto the target year's end-of-plan accumulator. Returns per-stack net
// (parallel to `stacks`) used as the cash backstop in planExposure.
function computeRetainedLiquidation(
  targetYearState: YearState,
  targetPeriod: PeriodState,
  retainedSharesByLot: number[],
  flatLots: FlatLot[],
  stackCount: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): number[] {
  const grossByStack = new Array<number>(stackCount).fill(0);
  const gainByStack = new Array<number>(stackCount).fill(0);
  let aggregateLongDelta = 0;
  let aggregateShortDelta = 0;

  for (let li = 0; li < flatLots.length; li += 1) {
    const shares = retainedSharesByLot[li];
    if (shares <= 0) continue;
    const meta = targetPeriod.lotMeta[li];
    // Lots vesting after the target date can't be liquidated as backstop;
    // skip them so we don't credit phantom proceeds or tax on a gain that
    // wouldn't actually be realized.
    if (!meta.acquired) continue;
    const fl = flatLots[li];
    const stack = fl.stackIndex;
    const gross = shares * targetPeriod.projectedPriceByStack[stack];
    const gain = shares * meta.gainPerShare;
    grossByStack[stack] += gross;
    gainByStack[stack] += gain;
    if (meta.isLongTerm) aggregateLongDelta += gain;
    else aggregateShortDelta += gain;
  }

  if (grossByStack.every((g) => g <= 0)) return grossByStack;

  // Tax the retained-liquidation delta through the shared year-tax primitive
  // (Schedule D netting, IRS worksheet stacking, per-bucket state, NIIT). The
  // helper nets the FULL-YEAR position internally, so pass the raw accumulator
  // totals with and without the retained deltas and difference them.
  //
  // This is a deliberate correctness change from the pre-phase-2 backstop,
  // which cross-offset only the retained-pool deltas among themselves before
  // adding them to the year accumulators. Netting the whole year together is
  // the correct Schedule D treatment (the scheduled sales' gains and the
  // retained pool share one tax return), so a retained loss now offsets the
  // year's scheduled gains rather than only the retained pool. This differs
  // only when the target year has scheduled gains AND the retained pool is
  // mixed-sign — largely unreachable in practice because the phase-2 signed
  // greedy harvests loss lots into the schedule rather than retaining them
  // (reachable mainly via future-vest lots that can't be sold at the sale
  // periods). See revision memo 148, Finding 1.
  const oldLong = targetYearState.longTermGainSoFar;
  const oldShort = targetYearState.shortTermGainSoFar;
  const taxNew = computeYearGainTax(
    ordinaryIncome,
    oldLong + aggregateLongDelta,
    oldShort + aggregateShortDelta,
    filingStatus,
    stateCode,
  );
  const taxOld = computeYearGainTax(ordinaryIncome, oldLong, oldShort, filingStatus, stateCode);
  const totalTaxDelta =
    taxNew.federal + taxNew.state + taxNew.niit - (taxOld.federal + taxOld.state + taxOld.niit);

  // Allocate the (possibly negative) tax delta across stacks by each
  // stack's contribution to the absolute-gain pool. For pure-gain cases
  // (the common one) this matches a sequential bracket-stack within
  // floating-point tolerance; for mixed gain/loss cases it gives loss
  // stacks a proportional share of the credit.
  const totalAbsGain = gainByStack.reduce((a, b) => a + Math.abs(b), 0);
  const taxByStack = new Array<number>(stackCount).fill(0);
  if (totalAbsGain > 0) {
    for (let s = 0; s < stackCount; s += 1) {
      taxByStack[s] = (totalTaxDelta * Math.abs(gainByStack[s])) / totalAbsGain;
    }
  }
  // Per-stack net is gross minus allocated tax. A negative allocation
  // (credit from a loss stack) raises that stack's backstop value above its
  // gross, which is correct: the loss creates tax savings on target-year
  // scheduled gains. Floor at 0 — the backstop can't be negative cash.
  return grossByStack.map((g, i) => Math.max(0, g - taxByStack[i]));
}

export function computeEquityFundingPlan(input: EquityFundingInput): EquityFundingResult {
  const today = input.today ?? new Date();
  const allYearPeriods = enumerateSaleDatesByYear(
    today,
    input.targetDate,
    input.saleDateOverrideForCurrentYear,
    input.useOnlyOverridePeriod,
  );
  const yearPeriods = input.restrictToSaleYears
    ? allYearPeriods.filter((p) => input.restrictToSaleYears!.includes(p.year))
    : allYearPeriods;
  if (yearPeriods.length === 0) {
    return emptyResult(input);
  }
  const stacks = normalizeStacks(input);
  const currentYear = today.getUTCFullYear();
  const lockInNowMinCash = input.lockInNowMinCash ?? 0;

  // Flatten (stack, lot) into a single linear list. flatLots[i] knows its
  // stackIndex + lotIndexInStack, so result reporting can break sales out
  // per stack. (Shared helper — see ./lotSelector.)
  const flatLots: FlatLot[] = flattenStacks(stacks, today);

  // Global lot inventory — shared across all years. Index matches flatLots[].
  const inventory: LotInventory[] = flatLots.map((fl) => ({ sharesRemaining: fl.shares }));

  // Build per-year state. Each year owns its tax accumulator plus one
  // PeriodState per scheduled sale date in that year (end-of-month +
  // target-date, or just today's override for the current year when
  // Lock-in-now / hybrid lock-in is in phase 1).
  const yearStates: YearState[] = yearPeriods.map(({ year, saleDates }) => {
    const periods: PeriodState[] = saleDates.map((saleDate) => {
      const projectedPriceByStack = stacks.map((s) =>
        projectPrice(s.currentPrice, s.expectedAnnualGrowth ?? 0, today, saleDate),
      );
      const lotMeta = flatLots.map((fl) => ({
        gainPerShare: projectedPriceByStack[fl.stackIndex] - fl.costBasisPerShare,
        isLongTerm: isLongTermFor(fl.acquisitionDate, saleDate),
        acquired: fl.acquisitionDate.getTime() <= saleDate.getTime(),
      }));
      return { saleDate, projectedPriceByStack, lotMeta };
    });
    return {
      year,
      longTermGainSoFar: 0,
      shortTermGainSoFar: 0,
      periods,
    };
  });

  // Track sales + per-(year, period, lot) tax for the final report.
  const salesMatrix: number[][][] = yearStates.map((ys) =>
    ys.periods.map(() => flatLots.map(() => 0)),
  );
  const taxMatrix: Array<Array<Array<{ federal: number; stateT: number; niit: number; gain: number }>>> =
    yearStates.map((ys) =>
      ys.periods.map(() => flatLots.map(() => ({ federal: 0, stateT: 0, niit: 0, gain: 0 }))),
    );

  // Sanity guard.
  const totalSharesAvailable = flatLots.reduce((acc, l) => acc + l.shares, 0);
  if (totalSharesAvailable <= 0) {
    return emptyResult(input);
  }

  // Greedy block fill. Block size starts at 100 shares for speed; falls
  // back to 1 share for the final shortfall. Cap at 2M iterations to
  // bound worst-case runtime.
  let cumulativeNet = 0;
  let totalGross = 0;
  let totalShares = 0;
  let totalFed = 0;
  let totalState = 0;
  let totalNiit = 0;

  // Cash interest: net cash from each sale grows from sale date to target
  // date at this rate. The greedy optimizes against FUTURE value (cash at
  // target), not raw cash, so the goal is met in deadline dollars. The
  // nominal user-entered rate is grossed-up; interest income is taxed as
  // ordinary at the user's marginal rate every year, so we compound at the
  // after-tax effective rate to keep the cash-vs-stock-growth trade-off
  // fair (stock appreciation is also unrealized / pre-tax in the wealth
  // metric).
  const cashInterestRate = effectiveAfterTaxCashRate(
    input.cashInterestRate ?? 0,
    input.ordinaryIncome,
    input.filingStatus,
    input.stateCode,
  );
  const targetTimeMs = input.targetDate.getTime();
  const MS_PER_YEAR = 365.25 * 86_400_000;
  const growthFactorPerPeriod: number[][] = yearStates.map((ys) =>
    ys.periods.map((p) => {
      const yearsForward = Math.max(0, (targetTimeMs - p.saleDate.getTime()) / MS_PER_YEAR);
      return Math.pow(1 + cashInterestRate, yearsForward);
    }),
  );

  // Track per-period net cash so spreadEvenlyAcrossPeriods can throttle a
  // period when it's already filled its fair-share quota. Only used when
  // the flag is set; otherwise periods can be reused freely.
  const periodNetSoFar: number[][] = yearStates.map((ys) => ys.periods.map(() => 0));
  const spreadEvenly = input.spreadEvenlyAcrossPeriods === true;
  // Total periods available in phase 2 (everything except the override
  // today-period that phase 1 monopolizes). Used to size each period's quota.
  const phase2PeriodCount = yearStates.reduce(
    (count, ys) => count + ys.periods.length,
    0,
  );

  // Locate the override period within yearStates (phase 1 may only sell
  // there). Without this, phase 1 of a same-year hybrid could pile sales
  // into a Jun/Jul EOM instead of today and break the lock-in invariant.
  let overrideYi = -1;
  let overridePi = -1;
  if (input.saleDateOverrideForCurrentYear) {
    const tT = input.saleDateOverrideForCurrentYear.getTime();
    for (let yi = 0; yi < yearStates.length && overrideYi < 0; yi += 1) {
      const ys = yearStates[yi];
      if (ys.year !== currentYear) continue;
      for (let pi = 0; pi < ys.periods.length; pi += 1) {
        if (Math.abs(ys.periods[pi].saleDate.getTime() - tT) < 12 * 3600 * 1000) {
          overrideYi = yi;
          overridePi = pi;
          break;
        }
      }
    }
  }

  // Track BOTH raw cash and target-date future value of cash. The greedy
  // optimizes future value (matches the goal expressed in deadline
  // dollars); raw cash is reported separately for display.
  let cumulativeFutureValue = 0;

  // Value of KEEPING each share to the target date = its projected target-date
  // price. The greedy ranks candidate sales by conversion benefit — cash-now
  // future value minus this hold value — so it funds the goal from the shares
  // you'd least want to keep first (e.g. a stack projected to DECLINE), rather
  // than simply the highest-priced shares. When two candidates have the same
  // forward value (same stack, or same price+growth), the hold value cancels
  // and the ranking reduces to cash-per-share — i.e. the prior tax-efficiency
  // ordering (sell the lowest-gain, lowest-tax shares first) is preserved.
  const targetProjectedByStack = stacks.map((s) =>
    projectPrice(s.currentPrice, s.expectedAnnualGrowth ?? 0, today, input.targetDate),
  );
  const holdValuePerShareByLot = flatLots.map(
    (fl) => targetProjectedByStack[fl.stackIndex],
  );

  const blockSizes = [100, 10, 1];
  for (let bsIdx = 0; bsIdx < blockSizes.length; bsIdx += 1) {
    const blockSize = blockSizes[bsIdx];
    const isFinestBlock = bsIdx === blockSizes.length - 1;
    let safety = 200_000;
    while (cumulativeFutureValue < input.targetAfterTax && safety-- > 0) {
      const inLockInPhase = cumulativeFutureValue < lockInNowMinCash;
      const phase2Target = Math.max(0, input.targetAfterTax - lockInNowMinCash);
      const quota = phase2PeriodCount > 0 ? phase2Target / phase2PeriodCount : Infinity;
      let bestYear = -1;
      let bestPeriod = -1;
      let bestLot = -1;
      let bestBenefitPerShare = -Infinity;
      let bestBlockShares = 0;
      let bestNetCash = 0;
      let bestFutureValue = 0;
      let bestTax = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const enforceQuota = spreadEvenly && !inLockInPhase && attempt === 0;
        for (let yi = 0; yi < yearStates.length; yi += 1) {
          const ys = yearStates[yi];
          if (inLockInPhase && overrideYi >= 0 && yi !== overrideYi) continue;
          if (inLockInPhase && overrideYi < 0 && ys.year !== currentYear) continue;
          for (let pi = 0; pi < ys.periods.length; pi += 1) {
            if (inLockInPhase && overridePi >= 0 && pi !== overridePi) continue;
            if (enforceQuota && periodNetSoFar[yi][pi] >= quota) continue;
            const period = ys.periods[pi];
            const gFactor = growthFactorPerPeriod[yi][pi];
            for (let li = 0; li < period.lotMeta.length; li += 1) {
              const meta = period.lotMeta[li];
              if (!meta.acquired) continue;
              if (inventory[li].sharesRemaining <= 0) continue;
              const candidateShares = Math.min(blockSize, inventory[li].sharesRemaining);
              const incrementalTax = marginalTaxForBlock(
                ys,
                period,
                inventory,
                li,
                candidateShares,
                input.ordinaryIncome,
                input.filingStatus,
                input.stateCode,
              );
              const incrementalGross =
                candidateShares * period.projectedPriceByStack[flatLots[li].stackIndex];
              const incrementalNet = incrementalGross - incrementalTax;
              const incrementalFutureValue = incrementalNet * gFactor;
              // Rank by conversion benefit: future value of selling now minus
              // the after-tax value of keeping these shares to the target.
              // Selling a share you'd otherwise keep at a higher value is a net
              // wealth loss (negative benefit); selling a declining holding is
              // a net gain. Maximizing benefit per share fills the cash goal
              // from the shares you least want to retain.
              const holdValue = candidateShares * holdValuePerShareByLot[li];
              const benefitPerShare = (incrementalFutureValue - holdValue) / candidateShares;
              if (benefitPerShare > bestBenefitPerShare) {
                bestBenefitPerShare = benefitPerShare;
                bestYear = yi;
                bestPeriod = pi;
                bestLot = li;
                bestBlockShares = candidateShares;
                bestNetCash = incrementalNet;
                bestFutureValue = incrementalFutureValue;
                bestTax = incrementalTax;
              }
            }
          }
        }
        if (bestYear >= 0) break;
      }
      if (bestYear < 0) break;

      // Lock-in precision: cap the winning block so the secured-today total
      // lands on lockInNowMinCash instead of overshooting it by up to a whole
      // coarse (100-share) block. Without this the amount locked in quantizes
      // to ~100-share steps, so shortfall-vs-lock-in-fraction moves in cliffs
      // that the findOptimalHybrid binary search can't bisect — leaving the
      // recommendation stranded well short of the user's risk ceiling. Only
      // the boundary block is capped (the bulk fills coarsely), and commitBlock
      // recomputes the tax for the capped size, so this stays fast and exact.
      if (
        inLockInPhase &&
        bestBlockShares > 1 &&
        cumulativeFutureValue + bestFutureValue > lockInNowMinCash
      ) {
        const perShareFutureValue = bestFutureValue / bestBlockShares;
        const room = lockInNowMinCash - cumulativeFutureValue;
        const capped = Math.max(1, Math.floor(room / perShareFutureValue));
        bestBlockShares = Math.min(bestBlockShares, capped);
      }

      if (!isFinestBlock && cumulativeFutureValue + bestFutureValue > input.targetAfterTax) {
        break;
      }

      const winningYear = yearStates[bestYear];
      const winningPeriod = winningYear.periods[bestPeriod];
      const breakdown = commitBlock(
        winningYear,
        winningPeriod,
        inventory,
        bestLot,
        bestBlockShares,
        input.ordinaryIncome,
        input.filingStatus,
        input.stateCode,
      );
      const gross =
        bestBlockShares * winningPeriod.projectedPriceByStack[flatLots[bestLot].stackIndex];
      const totalIncrementalTax = breakdown.federal + breakdown.stateT + breakdown.niit;
      const net = gross - totalIncrementalTax;
      cumulativeNet += net;
      cumulativeFutureValue += net * growthFactorPerPeriod[bestYear][bestPeriod];
      totalGross += gross;
      totalShares += bestBlockShares;
      totalFed += breakdown.federal;
      totalState += breakdown.stateT;
      totalNiit += breakdown.niit;
      salesMatrix[bestYear][bestPeriod][bestLot] += bestBlockShares;
      // periodNetSoFar tracks future-value (matches the per-period quota
      // for spreadEvenlyAcrossPeriods, which is also in target dollars).
      periodNetSoFar[bestYear][bestPeriod] += net * growthFactorPerPeriod[bestYear][bestPeriod];
      const existing = taxMatrix[bestYear][bestPeriod][bestLot];
      existing.federal += breakdown.federal;
      existing.stateT += breakdown.stateT;
      existing.niit += breakdown.niit;
      existing.gain += breakdown.gain;
      void bestTax;
    }
    if (cumulativeFutureValue >= input.targetAfterTax) break;
  }

  // Build schedule output — one entry per (year, period) with non-zero
  // sales. Field is still named YearSchedule for backward compat, but
  // multiple entries can share the same `year` when monthly sales spread
  // across the calendar year.
  const schedule: YearSchedule[] = [];
  let runningNet = 0;
  for (let yi = 0; yi < yearStates.length; yi += 1) {
    const ys = yearStates[yi];
    for (let pi = 0; pi < ys.periods.length; pi += 1) {
      const period = ys.periods[pi];
      const sales: SaleEntry[] = [];
      let periodGross = 0;
      let periodTax = 0;
      for (let li = 0; li < flatLots.length; li += 1) {
        const shares = salesMatrix[yi][pi][li];
        if (shares <= 0) continue;
        const tax = taxMatrix[yi][pi][li];
        const fl = flatLots[li];
        const gross = shares * period.projectedPriceByStack[fl.stackIndex];
        const totalTaxThisSale = tax.federal + tax.stateT + tax.niit;
        sales.push({
          stackIndex: fl.stackIndex,
          ticker: stacks[fl.stackIndex].ticker,
          lotIndex: fl.lotIndexInStack,
          shares,
          grossProceeds: gross,
          gainAmount: tax.gain,
          isLongTerm: period.lotMeta[li].isLongTerm,
          federalTax: tax.federal,
          stateTax: tax.stateT,
          niit: tax.niit,
          netCash: gross - totalTaxThisSale,
        });
        periodGross += gross;
        periodTax += totalTaxThisSale;
      }
      if (sales.length === 0) continue;
      const periodNet = periodGross - periodTax;
      // runningCumulativeNet is in TARGET-DATE dollars so it matches the
      // user's goal and the headline total. Per-period yearNetCash stays
      // raw (= what you actually receive that day).
      runningNet += periodNet * growthFactorPerPeriod[yi][pi];
      schedule.push({
        year: ys.year,
        saleDateISO: period.saleDate.toISOString().slice(0, 10),
        sales,
        yearGrossProceeds: periodGross,
        yearTotalTax: periodTax,
        yearNetCash: periodNet,
        runningCumulativeNet: runningNet,
      });
    }
  }

  // Counterfactual: sell everything needed in the target year (single-
  // year liquidation, no bracket splitting). We do this by running the
  // same algorithm with only the target year available.
  const counterfactual = computeSingleYearCounterfactual(input);

  const feasible = cumulativeFutureValue >= input.targetAfterTax - 0.5;
  // Future value of all sales at the target date (matches user's goal,
  // which is also in target-date dollars). Raw cash receipts may be less
  // when cashInterestRate > 0 because interest grows the cash forward.
  const totalAfterTax = cumulativeFutureValue;
  // Sum sales over (year, period) for each flat lot.
  const sharesSoldByLot = (lotIdx: number): number => {
    let s = 0;
    for (const yearMatrix of salesMatrix) {
      for (const periodRow of yearMatrix) s += periodRow[lotIdx];
    }
    return s;
  };
  const remainingShares = flatLots.reduce(
    (acc, fl, idx) => acc + fl.shares - sharesSoldByLot(idx),
    0,
  );
  // targetProjectedByStack (projected $/share at targetDate) is computed once
  // before the greedy and reused here to value leftover shares.
  const remainingPositionValue = flatLots.reduce((acc, fl, idx) => {
    const remaining = fl.shares - sharesSoldByLot(idx);
    return acc + remaining * targetProjectedByStack[fl.stackIndex];
  }, 0);

  // Net-of-tax retained value: hypothetical liquidation of all remaining
  // lots at the target date, layered onto the target year's end-of-plan
  // gain accumulator so the bracket walk is correct.
  const retainedSharesByLot = flatLots.map((fl, idx) => fl.shares - sharesSoldByLot(idx));
  // Value the leftover shares at the TARGET DATE, not at the last scheduled
  // sale period. For restrictToSaleYears plans (Lock-in-now sells only in the
  // current year; its last period is *today*) that distinction is the whole
  // ballgame: pricing leftovers at today's price and stacking their tax on the
  // current year's realized gains badly mis-valued retained inventory (it even
  // produced after-tax > pre-tax for a held gain). Build a period at the
  // target date and stack the hypothetical liquidation on the TARGET year's
  // accumulator — zero when the plan scheduled no sales in the target year.
  const targetYear = input.targetDate.getUTCFullYear();
  const retainedPeriod: PeriodState = {
    saleDate: input.targetDate,
    projectedPriceByStack: targetProjectedByStack,
    lotMeta: flatLots.map((fl) => ({
      gainPerShare: targetProjectedByStack[fl.stackIndex] - fl.costBasisPerShare,
      isLongTerm: isLongTermFor(fl.acquisitionDate, input.targetDate),
      acquired: fl.acquisitionDate.getTime() <= input.targetDate.getTime(),
    })),
  };
  const retainedYearState: YearState =
    yearStates.find((ys) => ys.year === targetYear) ?? {
      year: targetYear,
      longTermGainSoFar: 0,
      shortTermGainSoFar: 0,
      periods: [],
    };
  const remainingNetByStack = computeRetainedLiquidation(
    retainedYearState,
    retainedPeriod,
    retainedSharesByLot,
    flatLots,
    stacks.length,
    input.ordinaryIncome,
    input.filingStatus,
    input.stateCode,
  );
  const remainingPositionAfterTax = remainingNetByStack.reduce((a, b) => a + b, 0);

  const result: EquityFundingResult = {
    feasible,
    targetAfterTax: input.targetAfterTax,
    targetDateISO: input.targetDate.toISOString().slice(0, 10),
    totalAfterTaxAchieved: round2(totalAfterTax),
    totalSharesSold: totalShares,
    totalGrossProceeds: round2(totalGross),
    totalTaxes: {
      federal: round2(totalFed),
      state: round2(totalState),
      niit: round2(totalNiit),
      total: round2(totalFed + totalState + totalNiit),
    },
    schedule,
    comparison: {
      sellAllInTargetYearTotalTax: round2(counterfactual.totalTax),
      sellAllInTargetYearAfterTax: round2(counterfactual.afterTax),
      optimizedSavingsVsTargetYearSale: round2(
        counterfactual.totalTax - (totalFed + totalState + totalNiit),
      ),
      optimizedSavingsPct:
        counterfactual.totalTax > 0
          ? round4(
              (counterfactual.totalTax - (totalFed + totalState + totalNiit)) /
                counterfactual.totalTax,
            )
          : 0,
    },
    remainingShares,
    remainingPositionValue: round2(remainingPositionValue),
    remainingPositionAfterTax: round2(remainingPositionAfterTax),
    remainingNetByStack: remainingNetByStack.map(round2),
  };

  if (!feasible) {
    result.shortfall = {
      maxAchievableAfterTax: round2(totalAfterTax),
      gap: round2(input.targetAfterTax - totalAfterTax),
    };
  }

  return result;
}

// Counterfactual where the user sells everything they need in a single
// tax year (the target year). Gives us the comparison baseline for
// "savings vs sell-all-now" reporting.
function computeSingleYearCounterfactual(
  input: EquityFundingInput,
): { totalTax: number; afterTax: number; sharesSold: number } {
  const singleYearInput: EquityFundingInput = {
    ...input,
    targetDate: input.targetDate,
    today: new Date(Date.UTC(input.targetDate.getUTCFullYear(), 0, 1)),
  };
  const years = enumerateYears(singleYearInput.today!, singleYearInput.targetDate);
  if (years.length !== 1) {
    // Fallback: caller's target date isn't in the inferred year. Re-anchor.
  }
  const cfStacks = normalizeStacks(input);
  const cfToday = input.today ?? new Date();
  const cfFlatLots: FlatLot[] = flattenStacks(cfStacks, cfToday);
  const cfInventory: LotInventory[] = cfFlatLots.map((fl) => ({ sharesRemaining: fl.shares }));
  const cfProjectedByStack = cfStacks.map((s) =>
    projectPrice(s.currentPrice, s.expectedAnnualGrowth ?? 0, cfToday, input.targetDate),
  );
  const period: PeriodState = {
    saleDate: input.targetDate,
    projectedPriceByStack: cfProjectedByStack,
    lotMeta: cfFlatLots.map((fl) => ({
      gainPerShare: cfProjectedByStack[fl.stackIndex] - fl.costBasisPerShare,
      isLongTerm: isLongTermFor(fl.acquisitionDate, input.targetDate),
      acquired: fl.acquisitionDate.getTime() <= input.targetDate.getTime(),
    })),
  };
  const ys: YearState = {
    year: input.targetDate.getUTCFullYear(),
    longTermGainSoFar: 0,
    shortTermGainSoFar: 0,
    periods: [period],
  };

  let cumulativeNet = 0;
  let totalFed = 0;
  let totalState = 0;
  let totalNiit = 0;
  let totalShares = 0;
  const blockSizes = [100, 10, 1];
  for (let bsIdx = 0; bsIdx < blockSizes.length; bsIdx += 1) {
    const blockSize = blockSizes[bsIdx];
    const isFinestBlock = bsIdx === blockSizes.length - 1;
    let safety = 200_000;
    while (cumulativeNet < input.targetAfterTax && safety-- > 0) {
      let bestLot = -1;
      let bestNetPerShare = -Infinity;
      let bestBlockShares = 0;
      let bestNetCash = 0;
      for (let li = 0; li < period.lotMeta.length; li += 1) {
        const meta = period.lotMeta[li];
        if (!meta.acquired) continue;
        if (cfInventory[li].sharesRemaining <= 0) continue;
        const candidateShares = Math.min(blockSize, cfInventory[li].sharesRemaining);
        const incrementalTax = marginalTaxForBlock(
          ys,
          period,
          cfInventory,
          li,
          candidateShares,
          input.ordinaryIncome,
          input.filingStatus,
          input.stateCode,
        );
        const incrementalGross =
          candidateShares * period.projectedPriceByStack[cfFlatLots[li].stackIndex];
        const incrementalNet = incrementalGross - incrementalTax;
        const netPerShare = incrementalNet / candidateShares;
        if (netPerShare > bestNetPerShare) {
          bestNetPerShare = netPerShare;
          bestLot = li;
          bestBlockShares = candidateShares;
          bestNetCash = incrementalNet;
        }
      }
      if (bestLot < 0) break;
      if (!isFinestBlock && cumulativeNet + bestNetCash > input.targetAfterTax) {
        break;
      }
      const breakdown = commitBlock(
        ys,
        period,
        cfInventory,
        bestLot,
        bestBlockShares,
        input.ordinaryIncome,
        input.filingStatus,
        input.stateCode,
      );
      const gross =
        bestBlockShares * period.projectedPriceByStack[cfFlatLots[bestLot].stackIndex];
      const tax = breakdown.federal + breakdown.stateT + breakdown.niit;
      cumulativeNet += gross - tax;
      totalFed += breakdown.federal;
      totalState += breakdown.stateT;
      totalNiit += breakdown.niit;
      totalShares += bestBlockShares;
    }
    if (cumulativeNet >= input.targetAfterTax) break;
  }
  return {
    totalTax: totalFed + totalState + totalNiit,
    afterTax: cumulativeNet,
    sharesSold: totalShares,
  };
}

function emptyResult(input: EquityFundingInput): EquityFundingResult {
  return {
    feasible: false,
    targetAfterTax: input.targetAfterTax,
    targetDateISO: input.targetDate.toISOString().slice(0, 10),
    totalAfterTaxAchieved: 0,
    totalSharesSold: 0,
    totalGrossProceeds: 0,
    totalTaxes: { federal: 0, state: 0, niit: 0, total: 0 },
    schedule: [],
    comparison: {
      sellAllInTargetYearTotalTax: 0,
      sellAllInTargetYearAfterTax: 0,
      optimizedSavingsVsTargetYearSale: 0,
      optimizedSavingsPct: 0,
    },
    remainingShares: 0,
    remainingPositionValue: 0,
    remainingPositionAfterTax: 0,
    remainingNetByStack: [],
    shortfall: { maxAchievableAfterTax: 0, gap: input.targetAfterTax },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

// ----- Plan comparison + risk model ---------------------------------------

export type PlanKey = 'recommended' | 'lock_in_now' | 'balanced' | 'hold_for_growth' | 'candidate';

export interface NamedPlan {
  planKey: PlanKey;
  planLabel: string;
  /** The plan output from computeEquityFundingPlan. */
  plan: EquityFundingResult;
  /** Cash netted + remaining shares × projected target-date price. */
  wealthAtTarget: number;
  /** Total tax paid across the plan (sum of all scheduled sales' tax). */
  totalTax: number;
  /** Lognormal probability that realized cash < user target. 0 = deterministic
   *  hit (Lock-in-now with sufficient inventory); positive = there's price
   *  uncertainty between now and the plan's sale dates. */
  shortfallProbability: number;
  /** The lock-in fraction (0–1) that produced this candidate, if a hybrid. */
  lockInFraction?: number;
}

export interface EquityFundingComparisonInput extends EquityFundingInput {
  /** User's max acceptable P(shortfall), 0-1. Default 0.10 (10%). */
  riskToleranceShortfall?: number;
  /** Annualized volatility for tickers without per-stack overrides. Default 0.35. */
  defaultVolatility?: number;
  /** Per-stack annualized vol; index matches input.stacks. null = use default. */
  stackVolatilities?: (number | null)[];
}

export interface EquityFundingComparisonResult {
  /** The wealth-optimal plan whose P(shortfall) ≤ riskToleranceShortfall. */
  recommended: NamedPlan;
  /** Sell entirely in the current calendar year — minimum risk. */
  lockInNow: NamedPlan;
  /** Bracket-aware spread across all candidate years — minimum tax. */
  balanced: NamedPlan;
  /** Sell only in the target year — maximum wealth, maximum risk. */
  holdForGrowth: NamedPlan;
  /** All candidate plans from the bias sweep + 3 named, sorted by P(shortfall). */
  frontier: NamedPlan[];
  targetAfterTax: number;
  targetDateISO: string;
  appliedRiskTolerance: number;
}

// Standard normal CDF — Abramowitz & Stegun 26.2.17. Accurate to ~7e-8.
function phi(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function wealthAtTargetFor(plan: EquityFundingResult): number {
  // Cash already netted (after capital-gains tax + after-tax cash interest)
  // plus the AFTER-TAX value of unsold shares, so plans that retain more
  // inventory aren't credited for tax they'd still owe on liquidation. This
  // is the basis the recommendation picker compares on.
  return plan.totalAfterTaxAchieved + plan.remainingPositionAfterTax;
}

// reduce() comparator: keep whichever plan has the lower shortfall probability.
// Used both as the no-eligible-plan fallback and as the wealth-tie breaker.
const lowerShortfall = (a: NamedPlan, b: NamedPlan): NamedPlan =>
  b.shortfallProbability < a.shortfallProbability ? b : a;

/**
 * Standard deviation of realized after-tax cash for a plan, under the
 * lognormal price model. For each scheduled sale, models price at sale
 * date as lognormal with σ × √Δt uncertainty. Sums independent variance
 * contributions across sales. First-order linearization of net cash w.r.t.
 * price (ignores tax-bracket nonlinearities).
 */
// Decomposes a plan into:
//   secured   — cash netted from today's deterministic sales (in the bank)
//   exposed   — at-target dollars that move with the stock: future scheduled
//               sales' net cash + after-tax value of retained shares treated
//               as a backstop the user can sell at target if scheduled sales
//               come in light
//   sigma2t   — effective σ²×t for the exposed portion, dollar-weighted
//               across non-today scheduled sales AND retained shares (each
//               retained leg uses its stack's σ over the full now-to-target
//               horizon, since the share is held until target before being
//               liquidated as backstop)
//
// Under dynamic execution, the secured portion is in the bank; the exposed
// portion fluctuates with realized prices. Shortfall happens when realized
// exposed value falls below (goal − secured).
function planExposure(
  plan: EquityFundingResult,
  input: EquityFundingComparisonInput,
  today: Date,
): { secured: number; exposed: number; sigma2t: number } {
  const defaultVol = input.defaultVolatility ?? 0.30;
  const stackVols = input.stackVolatilities ?? [];
  // Match the greedy's after-tax compounding so planExposure agrees with
  // computeEquityFundingPlan's own cumulative cash numbers.
  const cashInterestRate = effectiveAfterTaxCashRate(
    input.cashInterestRate ?? 0,
    input.ordinaryIncome,
    input.filingStatus,
    input.stateCode,
  );
  const ONE_DAY_YEARS = 1 / 365.25;
  const MS_PER_YEAR = 365.25 * 86_400_000;
  const targetTimeMs = new Date(plan.targetDateISO + 'T12:00:00Z').getTime();
  const yearsToTarget = Math.max(0, (targetTimeMs - today.getTime()) / MS_PER_YEAR);
  let secured = 0;
  let exposedNotional = 0;
  let weightedSigma2t = 0;
  for (const yearRow of plan.schedule) {
    const saleTime = new Date(yearRow.saleDateISO + 'T12:00:00Z').getTime();
    const yearsForward = Math.max(0, (saleTime - today.getTime()) / MS_PER_YEAR);
    const yearsFromSaleToTarget = Math.max(0, (targetTimeMs - saleTime) / MS_PER_YEAR);
    const cashGrowth = Math.pow(1 + cashInterestRate, yearsFromSaleToTarget);
    const isToday = yearsForward < ONE_DAY_YEARS;
    for (const sale of yearRow.sales) {
      if (isToday) {
        // Today's cash is deterministic; its value at target = raw × growth.
        secured += sale.netCash * cashGrowth;
      } else {
        // Single-lognormal approximation for the exposed pool: pretend
        // every non-today leg shares one effective σ²t, dollar-weighted by
        // its contribution to the target-date pool. Dollar-weighting (not
        // share-weighting) is required so multi-stack scenarios with
        // different prices don't mis-scale a high-priced stack's exposure.
        const sigma = stackVols[sale.stackIndex] ?? defaultVol;
        const notionalAtTarget = sale.netCash * cashGrowth;
        exposedNotional += notionalAtTarget;
        weightedSigma2t += sigma * sigma * yearsForward * notionalAtTarget;
      }
    }
  }
  // Retained shares as backstop: each stack's after-tax target-date value
  // contributes to the exposed pool, weighted by its full now-to-target σ²t
  // (the share is held the whole way before any hypothetical liquidation).
  for (let si = 0; si < plan.remainingNetByStack.length; si += 1) {
    const stackNet = plan.remainingNetByStack[si];
    if (stackNet <= 0) continue;
    const sigma = stackVols[si] ?? defaultVol;
    exposedNotional += stackNet;
    weightedSigma2t += sigma * sigma * yearsToTarget * stackNet;
  }
  const sigma2t = exposedNotional > 0 ? weightedSigma2t / exposedNotional : 0;
  return { secured, exposed: exposedNotional, sigma2t };
}

/**
 * P(realized convertible cash < userTarget) under the dynamic-execution
 * model with secured/exposed decomposition.
 *
 * Total convertible cash = secured + exposed × X, where:
 *   - secured = cash from today's deterministic sales (in the bank)
 *   - exposed = future scheduled sales' net cash at target prices PLUS
 *               after-tax value of retained shares treated as backstop
 *   - X      = lognormal multiplier with median 1, σ²t dollar-weighted
 *              across all exposed legs (scheduled + retained backstop)
 *
 * Shortfall iff secured + exposed × X < goal, i.e. X < (goal − secured) / exposed.
 * When secured already covers the goal, shortfall is 0% regardless of X.
 * When exposed = 0 (Lock-in-now), the plan is fully deterministic.
 */
export function computeShortfallProbability(
  plan: EquityFundingResult,
  input: EquityFundingComparisonInput,
  today: Date,
  userTarget?: number,
): number {
  const target = userTarget ?? input.targetAfterTax;
  const { secured, exposed, sigma2t } = planExposure(plan, input, today);
  if (secured >= target) return 0;
  const gap = target - secured;
  if (exposed <= 0) return 1;
  if (sigma2t <= 0) {
    return exposed < gap ? 1 : 0;
  }
  // P(X < gap/exposed) for X ~ lognormal with median 1, variance e^{σ²t}-1.
  const sigma = Math.sqrt(sigma2t);
  const z = (Math.log(gap / exposed) + sigma2t / 2) / sigma;
  return phi(z);
}

/**
 * Build a plan that targets the user's goal exactly (no buffer over-sell).
 * Always returns a NamedPlan — infeasible plans (inventory can't cover goal
 * under that structure) propagate plan.feasible = false to the UI, which
 * surfaces a shortfall warning instead of crashing.
 */
function buildPlan(
  planKey: PlanKey,
  planLabel: string,
  baseExtra: Partial<EquityFundingInput>,
  input: EquityFundingComparisonInput,
  today: Date,
  lockInFraction?: number,
): NamedPlan {
  const probeInput: EquityFundingInput = { ...input, ...baseExtra };
  const result = computeEquityFundingPlan(probeInput);
  return {
    planKey,
    planLabel,
    plan: result,
    wealthAtTarget: round2(wealthAtTargetFor(result)),
    totalTax: result.totalTaxes.total,
    shortfallProbability: computeShortfallProbability(result, input, today, input.targetAfterTax),
    lockInFraction,
  };
}

// Binary-search the lock-in fraction f in [0, 1] that produces a plan whose
// shortfall lands ≈ tolerance. The relationship is monotone: shortfall
// decreases as f rises (more cash locked in = less exposure to future
// prices). We want the smallest f that still satisfies shortfall ≤ tolerance,
// since smaller f → less over-selling today → higher wealth at target.
function findOptimalHybrid(
  input: EquityFundingComparisonInput,
  today: Date,
  tolerance: number,
): NamedPlan {
  const makePlanAt = (f: number): NamedPlan =>
    buildPlan(
      'candidate',
      `Hybrid ${(f * 100).toFixed(1)}% locked in`,
      f <= 0
        ? { spreadEvenlyAcrossPeriods: true }
        : {
            lockInNowMinCash: input.targetAfterTax * f,
            saleDateOverrideForCurrentYear: today,
            spreadEvenlyAcrossPeriods: true,
          },
      input,
      today,
      f,
    );
  // If no lock-in (= Balanced) already satisfies tolerance, that's the
  // wealth-optimal choice.
  const noLock = makePlanAt(0);
  if (noLock.shortfallProbability <= tolerance) return noLock;
  // If full lock-in still exceeds tolerance, fall back to it (safest available).
  const fullLock = makePlanAt(1);
  if (fullLock.shortfallProbability > tolerance) return fullLock;
  // Bisect, then linear-scan the bracketed range. The discrete share-level
  // greedy can make shortfall(f) plateau or step — pure bisection sometimes
  // lands at a low-shortfall corner instead of the wealth-maximal point.
  // Tracking max-wealth across all evaluated plans handles this.
  let lo = 0;
  let hi = 1;
  let best = fullLock;
  const consider = (p: NamedPlan) => {
    if (p.shortfallProbability <= tolerance && p.wealthAtTarget > best.wealthAtTarget) {
      best = p;
    }
  };
  for (let i = 0; i < 18; i += 1) {
    const mid = (lo + hi) / 2;
    const p = makePlanAt(mid);
    consider(p);
    if (p.shortfallProbability <= tolerance) hi = mid;
    else lo = mid;
  }
  // Linear scan in the bracketed range to escape plateaus.
  for (let i = 0; i <= 12; i += 1) {
    const f = lo + (hi - lo) * (i / 12);
    consider(makePlanAt(f));
  }
  return best;
}

export function computeEquityFundingComparison(
  input: EquityFundingComparisonInput,
): EquityFundingComparisonResult {
  const today = input.today ?? new Date();
  const currentYear = today.getUTCFullYear();
  const targetYear = input.targetDate.getUTCFullYear();
  const tolerance = input.riskToleranceShortfall ?? 0.10;

  // Balanced spreads sales evenly across all monthly periods between today
  // and the target date — true dollar-cost-averaging behavior. Without the
  // spreadEvenlyAcrossPeriods flag the greedy would pile every sale onto
  // the latest, highest-priced period, collapsing Balanced to a single
  // sale identical to Hold-for-growth.
  const balanced = buildPlan(
    'balanced',
    'Balanced',
    { spreadEvenlyAcrossPeriods: true },
    input,
    today,
    0,
  );

  // Lock-in-now sells TODAY (sale date overridden, not Dec 31). Zero time
  // uncertainty → realized cash = projected cash deterministically → the
  // sd=0 branch in computeShortfallProbability returns 0 (or 1 if inventory
  // can't cover goal at today's prices).
  const lockInNow = buildPlan(
    'lock_in_now',
    'Lock in now',
    {
      restrictToSaleYears: [currentYear],
      saleDateOverrideForCurrentYear: today,
      useOnlyOverridePeriod: true,
    },
    input,
    today,
  );

  // Hold-for-growth sells only in the target year — biggest σ × √Δt.
  const holdForGrowth = buildPlan(
    'hold_for_growth',
    'Hold for growth',
    { restrictToSaleYears: [targetYear] },
    input,
    today,
  );

  // Continuous frontier between Lock-in-now and Balanced: vary how much of
  // the goal is locked in today (deterministic) vs. exposed to future-price
  // uncertainty. Each hybrid is a true two-phase plan. The shortfall
  // probability decreases smoothly as more is locked in now.
  const lockInFractions = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const hybridPlans: NamedPlan[] = lockInFractions.map((f) =>
    buildPlan(
      'candidate',
      `Hybrid ${Math.round(f * 100)}% locked in`,
      {
        lockInNowMinCash: input.targetAfterTax * f,
        saleDateOverrideForCurrentYear: today,
        spreadEvenlyAcrossPeriods: true,
      },
      input,
      today,
      f,
    ),
  );

  // Frontier excludes infeasible plans but the named-plan cards above the
  // table always render — even infeasible ones — so the user can see the
  // shortfall warning per plan.
  const frontier = [lockInNow, ...hybridPlans, balanced, holdForGrowth]
    .filter((p) => p.plan.feasible)
    .sort((a, b) => a.shortfallProbability - b.shortfallProbability);

  // Binary-search for the exact hybrid plan that lands at the user's
  // tolerance (smaller lock-in → higher wealth, so we want the smallest
  // lock-in fraction that still satisfies shortfall ≤ tolerance).
  const optimalHybrid = findOptimalHybrid(input, today, tolerance);
  // Recommend the wealth-maximal plan whose shortfall stays within tolerance,
  // chosen across EVERY candidate the chart plots — the named corners, the
  // full fixed-fraction hybrid sweep, AND the binary-searched optimal hybrid —
  // not a narrow subset. Selecting from a subset let a plotted hybrid dot
  // dominate the recommendation (more wealth at lower risk), which read as a
  // broken frontier chart. Including the whole pool guarantees no feasible dot
  // can sit above-and-left of the recommended star.
  const recommendationPool: NamedPlan[] = [
    lockInNow,
    ...hybridPlans,
    balanced,
    holdForGrowth,
    optimalHybrid,
  ];
  const eligible = recommendationPool.filter(
    (p) => p.plan.feasible && p.shortfallProbability <= tolerance,
  );
  let optimal: NamedPlan;
  if (eligible.length === 0) {
    // Tolerance is below even the safest available plan's residual risk —
    // recommend the lowest-shortfall feasible plan (closest to satisfying it).
    const feasibleAll = recommendationPool.filter((p) => p.plan.feasible);
    optimal = (feasibleAll.length > 0 ? feasibleAll : recommendationPool).reduce(lowerShortfall);
  } else {
    // Among eligible plans, pick the highest wealth. The greedy is only
    // optimal to ~1-2%, so treat wealth within 0.05% (floor $100) of the best
    // as a TIE and break it toward the lower-risk plan — never recommend extra
    // shortfall risk to buy wealth the user can't meaningfully distinguish.
    const maxWealth = Math.max(...eligible.map((p) => p.wealthAtTarget));
    const tieEps = Math.max(100, maxWealth * 5e-4);
    optimal = eligible
      .filter((p) => p.wealthAtTarget >= maxWealth - tieEps)
      .reduce(lowerShortfall);
  }
  const recommended: NamedPlan = {
    ...optimal,
    planKey: 'recommended',
    planLabel: 'Recommended',
  };

  return {
    recommended,
    lockInNow,
    balanced,
    holdForGrowth,
    frontier,
    targetAfterTax: input.targetAfterTax,
    targetDateISO: input.targetDate.toISOString().slice(0, 10),
    appliedRiskTolerance: tolerance,
  };
}
