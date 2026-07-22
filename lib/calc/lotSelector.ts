// AlphaLatitude Inc. © 2026
//
// Lot-selection machinery shared by the equity-funding planner and the
// RSU lot-order planner. This module owns the tax-lot primitives — the
// flattened (stack, lot) inventory, per-year/per-period tax state, the
// long-term holding test, and the incremental block-tax functions — that
// both engines build their greedy on top of.
//
// Phase 1 of the RSU-lot-order build (docs/tools/rsu-lot-order-spec.md) is
// a VERBATIM extraction from equityFunding.ts: these definitions moved here
// unchanged, and the flatten helper unifies the two identical inline copies
// that lived in computeEquityFundingPlan and computeSingleYearCounterfactual.
// No behavior changes in this module — the equity-funding invariance
// snapshots gate that. The tax-law corrections the RSU tool needs (Schedule
// D netting, LT/ST stacking order, the calendar long-term rule, per-bucket
// state tax) land in a SEPARATE phase-2 PR, as documented intentional
// changes with before/after deltas — never smuggled into this move.

import {
  computeFederalGainTax,
  computeNiit,
} from '../tax/bracket-walker';
import { computeStateGainTax } from '../tax/state-tax';
import type { FilingStatus } from '../tax/types';

export const MS_PER_DAY = 86_400_000;
export const LT_HOLDING_DAYS = 366;

// Projected $/share at `saleDate`, compounding currentPrice at the annual
// growth rate. Returns currentPrice unchanged when growth=0 (preserves
// v1.5 behavior for callers who omit expectedAnnualGrowth).
export function projectPrice(currentPrice: number, growthAnnual: number, today: Date, saleDate: Date): number {
  if (growthAnnual === 0) return currentPrice;
  const yearsForward = Math.max(0, (saleDate.getTime() - today.getTime()) / (365.25 * MS_PER_DAY));
  return currentPrice * Math.pow(1 + growthAnnual, yearsForward);
}

export function isLongTermFor(acquisitionDate: Date, saleDate: Date): boolean {
  const diff = (saleDate.getTime() - acquisitionDate.getTime()) / MS_PER_DAY;
  return diff >= LT_HOLDING_DAYS;
}

// Per-year tax accumulator, shared across all sale periods within the same
// calendar year (so multiple monthly sales all stack into the same year's
// LTCG bracket).
export interface YearState {
  year: number;
  longTermGainSoFar: number;
  shortTermGainSoFar: number;
  /** Sale periods within this year (typically end-of-month + target date). */
  periods: PeriodState[];
}

// A single sale opportunity (a specific date within a YearState).
export interface PeriodState {
  saleDate: Date;
  /** Projected $/share at this period's sale date, indexed by stack. */
  projectedPriceByStack: number[];
  /** Per flat-lot: gain/share at this period's price + LT classification +
   *  whether the lot is acquired by this date. Index matches flatLots[]. */
  lotMeta: Array<{ gainPerShare: number; isLongTerm: boolean; acquired: boolean }>;
}

// A flattened (stack, lot) entry — the algorithm treats stacks × lots as
// a single linear lot list with extra stackIndex bookkeeping for the
// result reporting.
export interface FlatLot {
  stackIndex: number;
  lotIndexInStack: number;
  shares: number;
  costBasisPerShare: number;
  acquisitionDate: Date;
}

// Global inventory: how many shares of each lot are still un-sold.
// Shared across all year states — selling 100 shares from lot L in year
// 2026 must reduce the same inventory that year 2027 sees.
export interface LotInventory {
  sharesRemaining: number;
}

// Minimal structural shape flattenStacks needs. EquityFundingStack (and any
// future RSU-lot stack) is assignable to this without importing the
// engine-specific domain types here.
export interface FlattenableStack {
  currentPrice: number;
  expectedAnnualGrowth?: number;
  lots: Array<{
    shares: number;
    costBasisPerShare: number;
    acquisitionDate: Date;
    /** Optional unvested-RSU marker: acquisitionDate = vestDate and basis =
     *  projected FMV at vest. See EquityFundingLot for the full contract. */
    vestDate?: Date;
  }>;
}

// Flatten (stack, lot) into a single linear list. flatLots[i] knows its
// stackIndex + lotIndexInStack, so result reporting can break sales out
// per stack. Unifies the two byte-identical inline copies that lived in
// computeEquityFundingPlan and computeSingleYearCounterfactual.
export function flattenStacks(stacks: FlattenableStack[], today: Date): FlatLot[] {
  const flatLots: FlatLot[] = [];
  for (let si = 0; si < stacks.length; si += 1) {
    const stack = stacks[si];
    for (let li = 0; li < stack.lots.length; li += 1) {
      const lot = stack.lots[li];
      const isRsuVest = lot.vestDate !== undefined;
      const acquisitionDate = isRsuVest ? lot.vestDate! : lot.acquisitionDate;
      const costBasisPerShare = isRsuVest
        ? projectPrice(stack.currentPrice, stack.expectedAnnualGrowth ?? 0, today, lot.vestDate!)
        : lot.costBasisPerShare;
      flatLots.push({
        stackIndex: si,
        lotIndexInStack: li,
        shares: lot.shares,
        costBasisPerShare,
        acquisitionDate,
      });
    }
  }
  return flatLots;
}

// Marginal tax for selling `deltaShares` more from `lotIdx` in year Y,
// given the year's running state. Returns the incremental federal +
// state + NIIT delta (not the total).
export function marginalTaxForBlock(
  state: YearState,
  period: PeriodState,
  inventory: LotInventory[],
  lotIdx: number,
  deltaShares: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): number {
  const meta = period.lotMeta[lotIdx];
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
export function commitBlock(
  state: YearState,
  period: PeriodState,
  inventory: LotInventory[],
  lotIdx: number,
  deltaShares: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): { federal: number; stateT: number; niit: number; gain: number } {
  const meta = period.lotMeta[lotIdx];
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
