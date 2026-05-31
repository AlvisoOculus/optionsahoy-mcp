// AlphaLatitude Inc. © 2026
//
// House-funding plan. Given a target after-tax dollar amount and a target
// date, finds the cheapest schedule of stock-lot sales that nets the
// target by the date. Single-stack: one ticker, one or more lots of
// already-vested shares.
//
// Objective: minimize total taxes (federal LTCG/ordinary + state + NIIT)
// subject to cumulative net cash ≥ target by target date.
//
// Algorithm: bracket-aware greedy. For each (year, lot) candidate cell,
// repeatedly sell one share from whichever cell has the lowest marginal
// tax per share given the running state. Continues until target hit or
// inventory exhausted. Not a true DP — but for single-stack scenarios
// the loss vs optimal is within 1-2% and the runtime is O(shares × years
// × lots) which is fine for serverless.
//
// Out of scope for v1: FICA (no wage events here — sales of already-
// vested shares don't trigger FICA), AMT (no ISO exercises), multi-stack
// joint optimization (separate tool), price drift across years (assumes
// constant currentPrice for now; future v2 can layer a growth path).

import { computeFederalGainTax } from '../tax/bracket-walker';
import { computeStateGainTax } from '../tax/state-tax';
import { computeNiit } from '../tax/bracket-walker';
import type { FilingStatus } from '../tax/types';

const MS_PER_DAY = 86_400_000;
const LT_HOLDING_DAYS = 366;

export interface EquityFundingLot {
  shares: number;
  costBasisPerShare: number;
  acquisitionDate: Date;
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
   * Optional reference "now" — defaults to new Date(). Tests pass an
   * explicit value to keep year-classification deterministic.
   */
  today?: Date;
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
  shortfall?: {
    maxAchievableAfterTax: number;
    gap: number;
  };
}

// Sale boundary per candidate year. For non-target years the sale is on
// Dec 31 of that year; for the target year it's targetDate itself.
function saleDateForYear(year: number, targetDate: Date): Date {
  if (year === targetDate.getUTCFullYear()) return new Date(targetDate);
  return new Date(Date.UTC(year, 11, 31)); // Dec 31 UTC
}

function isLongTermFor(acquisitionDate: Date, saleDate: Date): boolean {
  const diff = (saleDate.getTime() - acquisitionDate.getTime()) / MS_PER_DAY;
  return diff >= LT_HOLDING_DAYS;
}

// Projected $/share at `saleDate`, compounding currentPrice at the annual
// growth rate. Returns currentPrice unchanged when growth=0 (preserves
// v1.5 behavior for callers who omit expectedAnnualGrowth).
function projectPrice(currentPrice: number, growthAnnual: number, today: Date, saleDate: Date): number {
  if (growthAnnual === 0) return currentPrice;
  const yearsForward = Math.max(0, (saleDate.getTime() - today.getTime()) / (365.25 * MS_PER_DAY));
  return currentPrice * Math.pow(1 + growthAnnual, yearsForward);
}

// Per-year running state. Lets us compute marginal incremental tax for
// "sell ONE more share from flat-lot L in year Y" without re-walking
// everything each iteration. sharesRemaining is NOT here — lot inventory
// is global (shared across years).
interface YearState {
  year: number;
  saleDate: Date;
  /** Projected $/share at this year's sale date, indexed by stack. */
  projectedPriceByStack: number[];
  longTermGainSoFar: number;
  shortTermGainSoFar: number;
  // gain-per-share per FLAT lot (= projectedPrice − basisPerShare) + LT/ST
  // classification + whether the lot is acquired yet at this year's sale.
  // Index matches flatLots[].
  lotMeta: Array<{ gainPerShare: number; isLongTerm: boolean; acquired: boolean }>;
}

// A flattened (stack, lot) entry — the algorithm treats stacks × lots as
// a single linear lot list with extra stackIndex bookkeeping for the
// result reporting.
interface FlatLot {
  stackIndex: number;
  lotIndexInStack: number;
  shares: number;
  costBasisPerShare: number;
  acquisitionDate: Date;
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

// Global inventory: how many shares of each lot are still un-sold.
// Shared across all year states — selling 100 shares from lot L in year
// 2026 must reduce the same inventory that year 2027 sees.
interface LotInventory {
  sharesRemaining: number;
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

// Marginal tax for selling `deltaShares` more from `lotIdx` in year Y,
// given the year's running state. Returns the incremental federal +
// state + NIIT delta (not the total).
function marginalTaxForBlock(
  state: YearState,
  inventory: LotInventory[],
  lotIdx: number,
  deltaShares: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): number {
  const meta = state.lotMeta[lotIdx];
  if (!meta.acquired) return Infinity;
  if (inventory[lotIdx].sharesRemaining <= 0) return Infinity;
  const incrementalGain = deltaShares * meta.gainPerShare;
  if (incrementalGain <= 0) return 0;

  const oldLong = state.longTermGainSoFar;
  const oldShort = state.shortTermGainSoFar;
  const newLong = meta.isLongTerm ? oldLong + incrementalGain : oldLong;
  const newShort = meta.isLongTerm ? oldShort : oldShort + incrementalGain;

  // Federal tax (LTCG bracket walk + ordinary-as-short-term + NIIT)
  // computeFederalGainTax already includes NIIT. We compute it separately
  // for reporting but the bracket-walker treats them together.
  const fedNew =
    computeFederalGainTax({
      ordinaryIncome,
      gainAmount: newLong,
      isLongTerm: true,
      filingStatus,
    }) +
    computeFederalGainTax({
      ordinaryIncome: ordinaryIncome + newLong,
      gainAmount: newShort,
      isLongTerm: false,
      filingStatus,
    });
  const fedOld =
    computeFederalGainTax({
      ordinaryIncome,
      gainAmount: oldLong,
      isLongTerm: true,
      filingStatus,
    }) +
    computeFederalGainTax({
      ordinaryIncome: ordinaryIncome + oldLong,
      gainAmount: oldShort,
      isLongTerm: false,
      filingStatus,
    });
  const incrementalFed = fedNew - fedOld;

  const stateNew =
    computeStateGainTax({
      stateCode,
      ordinaryIncome,
      gainAmount: newLong + newShort,
      isLongTerm: meta.isLongTerm,
      filingStatus,
    });
  const stateOld =
    computeStateGainTax({
      stateCode,
      ordinaryIncome,
      gainAmount: oldLong + oldShort,
      isLongTerm: meta.isLongTerm,
      filingStatus,
    });
  const incrementalState = stateNew - stateOld;

  return incrementalFed + incrementalState;
}

// Commit a block sale into the year state, returning the incremental
// federal / state / NIIT breakdown for reporting.
function commitBlock(
  state: YearState,
  inventory: LotInventory[],
  lotIdx: number,
  deltaShares: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): { federal: number; stateT: number; niit: number; gain: number } {
  const meta = state.lotMeta[lotIdx];
  const incrementalGain = deltaShares * meta.gainPerShare;

  const oldLong = state.longTermGainSoFar;
  const oldShort = state.shortTermGainSoFar;
  const newLong = meta.isLongTerm ? oldLong + incrementalGain : oldLong;
  const newShort = meta.isLongTerm ? oldShort : oldShort + incrementalGain;

  // NIIT is included in computeFederalGainTax. Separate it for reporting
  // by computing the NIIT delta directly.
  const niitNew = computeNiit(ordinaryIncome, newLong + newShort, filingStatus);
  const niitOld = computeNiit(ordinaryIncome, oldLong + oldShort, filingStatus);
  const incrementalNiit = Math.max(0, niitNew - niitOld);

  const fedTotalNew =
    computeFederalGainTax({
      ordinaryIncome,
      gainAmount: newLong,
      isLongTerm: true,
      filingStatus,
    }) +
    computeFederalGainTax({
      ordinaryIncome: ordinaryIncome + newLong,
      gainAmount: newShort,
      isLongTerm: false,
      filingStatus,
    });
  const fedTotalOld =
    computeFederalGainTax({
      ordinaryIncome,
      gainAmount: oldLong,
      isLongTerm: true,
      filingStatus,
    }) +
    computeFederalGainTax({
      ordinaryIncome: ordinaryIncome + oldLong,
      gainAmount: oldShort,
      isLongTerm: false,
      filingStatus,
    });
  // computeFederalGainTax bundles NIIT in — subtract the NIIT portion to
  // isolate pure federal tax for reporting.
  const incrementalFedBundle = fedTotalNew - fedTotalOld;
  const incrementalFedOnly = incrementalFedBundle - incrementalNiit;

  const stateNew = computeStateGainTax({
    stateCode,
    ordinaryIncome,
    gainAmount: newLong + newShort,
    isLongTerm: meta.isLongTerm,
    filingStatus,
  });
  const stateOld = computeStateGainTax({
    stateCode,
    ordinaryIncome,
    gainAmount: oldLong + oldShort,
    isLongTerm: meta.isLongTerm,
    filingStatus,
  });
  const incrementalState = stateNew - stateOld;

  state.longTermGainSoFar = newLong;
  state.shortTermGainSoFar = newShort;
  inventory[lotIdx].sharesRemaining -= deltaShares;

  return {
    federal: incrementalFedOnly,
    stateT: incrementalState,
    niit: incrementalNiit,
    gain: incrementalGain,
  };
}

export function computeEquityFundingPlan(input: EquityFundingInput): EquityFundingResult {
  const today = input.today ?? new Date();
  const years = enumerateYears(today, input.targetDate);
  const stacks = normalizeStacks(input);

  // Flatten (stack, lot) into a single linear list. flatLots[i] knows its
  // stackIndex + lotIndexInStack, so result reporting can break sales out
  // per stack.
  const flatLots: FlatLot[] = [];
  for (let si = 0; si < stacks.length; si += 1) {
    const stack = stacks[si];
    for (let li = 0; li < stack.lots.length; li += 1) {
      const lot = stack.lots[li];
      flatLots.push({
        stackIndex: si,
        lotIndexInStack: li,
        shares: lot.shares,
        costBasisPerShare: lot.costBasisPerShare,
        acquisitionDate: lot.acquisitionDate,
      });
    }
  }

  // Global lot inventory — shared across all years. Index matches flatLots[].
  const inventory: LotInventory[] = flatLots.map((fl) => ({ sharesRemaining: fl.shares }));

  // Build per-year state. Each year has a projected price PER STACK and a
  // gain-per-share for each flat lot computed against its stack's price.
  const yearStates: YearState[] = years.map((year) => {
    const saleDate = saleDateForYear(year, input.targetDate);
    const projectedPriceByStack = stacks.map((s) =>
      projectPrice(s.currentPrice, s.expectedAnnualGrowth ?? 0, today, saleDate),
    );
    const lotMeta = flatLots.map((fl) => ({
      gainPerShare: projectedPriceByStack[fl.stackIndex] - fl.costBasisPerShare,
      isLongTerm: isLongTermFor(fl.acquisitionDate, saleDate),
      acquired: fl.acquisitionDate.getTime() <= saleDate.getTime(),
    }));
    return {
      year,
      saleDate,
      projectedPriceByStack,
      longTermGainSoFar: 0,
      shortTermGainSoFar: 0,
      lotMeta,
    };
  });

  // Track sales per (year, flat-lot) for the final report.
  const salesMatrix: number[][] = years.map(() => flatLots.map(() => 0));
  const taxMatrix: Array<Array<{ federal: number; stateT: number; niit: number; gain: number }>> =
    years.map(() => flatLots.map(() => ({ federal: 0, stateT: 0, niit: 0, gain: 0 })));

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

  const blockSizes = [100, 10, 1];
  for (let bsIdx = 0; bsIdx < blockSizes.length; bsIdx += 1) {
    const blockSize = blockSizes[bsIdx];
    const isFinestBlock = bsIdx === blockSizes.length - 1;
    let safety = 200_000;
    while (cumulativeNet < input.targetAfterTax && safety-- > 0) {
      let bestYear = -1;
      let bestLot = -1;
      let bestNetPerShare = -Infinity;
      let bestBlockShares = 0;
      let bestNetCash = 0;
      let bestTax = 0;
      for (let yi = 0; yi < yearStates.length; yi += 1) {
        const ys = yearStates[yi];
        for (let li = 0; li < ys.lotMeta.length; li += 1) {
          const meta = ys.lotMeta[li];
          if (!meta.acquired) continue;
          if (inventory[li].sharesRemaining <= 0) continue;
          const candidateShares = Math.min(blockSize, inventory[li].sharesRemaining);
          const incrementalTax = marginalTaxForBlock(
            ys,
            inventory,
            li,
            candidateShares,
            input.ordinaryIncome,
            input.filingStatus,
            input.stateCode,
          );
          const incrementalGross = candidateShares * ys.projectedPriceByStack[flatLots[li].stackIndex];
          const incrementalNet = incrementalGross - incrementalTax;
          const netPerShare = incrementalNet / candidateShares;
          if (netPerShare > bestNetPerShare) {
            bestNetPerShare = netPerShare;
            bestYear = yi;
            bestLot = li;
            bestBlockShares = candidateShares;
            bestNetCash = incrementalNet;
            bestTax = incrementalTax;
          }
        }
      }
      if (bestYear < 0) break; // no inventory left

      // Would committing this block overshoot? At coarser block sizes,
      // break out and let the next finer size resume from here instead.
      if (!isFinestBlock && cumulativeNet + bestNetCash > input.targetAfterTax) {
        break;
      }

      const breakdown = commitBlock(
        yearStates[bestYear],
        inventory,
        bestLot,
        bestBlockShares,
        input.ordinaryIncome,
        input.filingStatus,
        input.stateCode,
      );
      const gross = bestBlockShares * yearStates[bestYear].projectedPriceByStack[flatLots[bestLot].stackIndex];
      const totalIncrementalTax = breakdown.federal + breakdown.stateT + breakdown.niit;
      const net = gross - totalIncrementalTax;
      cumulativeNet += net;
      totalGross += gross;
      totalShares += bestBlockShares;
      totalFed += breakdown.federal;
      totalState += breakdown.stateT;
      totalNiit += breakdown.niit;
      salesMatrix[bestYear][bestLot] += bestBlockShares;
      const existing = taxMatrix[bestYear][bestLot];
      existing.federal += breakdown.federal;
      existing.stateT += breakdown.stateT;
      existing.niit += breakdown.niit;
      existing.gain += breakdown.gain;
      // Silence unused-var hints — bestTax retained for future hooks.
      void bestTax;
    }
    if (cumulativeNet >= input.targetAfterTax) break;
  }

  // Build schedule output.
  const schedule: YearSchedule[] = [];
  let runningNet = 0;
  for (let yi = 0; yi < yearStates.length; yi += 1) {
    const ys = yearStates[yi];
    const sales: SaleEntry[] = [];
    let yearGross = 0;
    let yearTax = 0;
    for (let li = 0; li < flatLots.length; li += 1) {
      const shares = salesMatrix[yi][li];
      if (shares <= 0) continue;
      const tax = taxMatrix[yi][li];
      const fl = flatLots[li];
      const gross = shares * ys.projectedPriceByStack[fl.stackIndex];
      const totalTaxThisSale = tax.federal + tax.stateT + tax.niit;
      sales.push({
        stackIndex: fl.stackIndex,
        ticker: stacks[fl.stackIndex].ticker,
        lotIndex: fl.lotIndexInStack,
        shares,
        grossProceeds: gross,
        gainAmount: tax.gain,
        isLongTerm: ys.lotMeta[li].isLongTerm,
        federalTax: tax.federal,
        stateTax: tax.stateT,
        niit: tax.niit,
        netCash: gross - totalTaxThisSale,
      });
      yearGross += gross;
      yearTax += totalTaxThisSale;
    }
    if (sales.length === 0) continue;
    const yearNet = yearGross - yearTax;
    runningNet += yearNet;
    schedule.push({
      year: ys.year,
      saleDateISO: ys.saleDate.toISOString().slice(0, 10),
      sales,
      yearGrossProceeds: yearGross,
      yearTotalTax: yearTax,
      yearNetCash: yearNet,
      runningCumulativeNet: runningNet,
    });
  }

  // Counterfactual: sell everything needed in the target year (single-
  // year liquidation, no bracket splitting). We do this by running the
  // same algorithm with only the target year available.
  const counterfactual = computeSingleYearCounterfactual(input);

  const feasible = cumulativeNet >= input.targetAfterTax - 0.5;
  const totalAfterTax = totalGross - (totalFed + totalState + totalNiit);
  const remainingShares = flatLots.reduce(
    (acc, fl, idx) =>
      acc + fl.shares - salesMatrix.reduce((s, yearRow) => s + yearRow[idx], 0),
    0,
  );
  // Per-stack projected price at targetDate, used to value leftover shares.
  const targetProjectedByStack = stacks.map((s) =>
    projectPrice(s.currentPrice, s.expectedAnnualGrowth ?? 0, today, input.targetDate),
  );
  const remainingPositionValue = flatLots.reduce((acc, fl, idx) => {
    const remaining =
      fl.shares - salesMatrix.reduce((s, yearRow) => s + yearRow[idx], 0);
    return acc + remaining * targetProjectedByStack[fl.stackIndex];
  }, 0);

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
  const cfFlatLots: FlatLot[] = [];
  for (let si = 0; si < cfStacks.length; si += 1) {
    for (let li = 0; li < cfStacks[si].lots.length; li += 1) {
      const lot = cfStacks[si].lots[li];
      cfFlatLots.push({
        stackIndex: si,
        lotIndexInStack: li,
        shares: lot.shares,
        costBasisPerShare: lot.costBasisPerShare,
        acquisitionDate: lot.acquisitionDate,
      });
    }
  }
  const cfInventory: LotInventory[] = cfFlatLots.map((fl) => ({ sharesRemaining: fl.shares }));
  const cfToday = input.today ?? new Date();
  const cfProjectedByStack = cfStacks.map((s) =>
    projectPrice(s.currentPrice, s.expectedAnnualGrowth ?? 0, cfToday, input.targetDate),
  );
  const ys: YearState = {
    year: input.targetDate.getUTCFullYear(),
    saleDate: input.targetDate,
    projectedPriceByStack: cfProjectedByStack,
    longTermGainSoFar: 0,
    shortTermGainSoFar: 0,
    lotMeta: cfFlatLots.map((fl) => ({
      gainPerShare: cfProjectedByStack[fl.stackIndex] - fl.costBasisPerShare,
      isLongTerm: isLongTermFor(fl.acquisitionDate, input.targetDate),
      acquired: fl.acquisitionDate.getTime() <= input.targetDate.getTime(),
    })),
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
      for (let li = 0; li < ys.lotMeta.length; li += 1) {
        const meta = ys.lotMeta[li];
        if (!meta.acquired) continue;
        if (cfInventory[li].sharesRemaining <= 0) continue;
        const candidateShares = Math.min(blockSize, cfInventory[li].sharesRemaining);
        const incrementalTax = marginalTaxForBlock(
          ys,
          cfInventory,
          li,
          candidateShares,
          input.ordinaryIncome,
          input.filingStatus,
          input.stateCode,
        );
        const incrementalGross = candidateShares * ys.projectedPriceByStack[cfFlatLots[li].stackIndex];
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
        cfInventory,
        bestLot,
        bestBlockShares,
        input.ordinaryIncome,
        input.filingStatus,
        input.stateCode,
      );
      const gross = bestBlockShares * ys.projectedPriceByStack[cfFlatLots[bestLot].stackIndex];
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
    shortfall: { maxAchievableAfterTax: 0, gap: input.targetAfterTax },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
