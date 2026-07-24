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
  computeNiit,
  walkOrdinaryBrackets,
  walkLtcgFederal,
} from '../tax/bracket-walker';
import { computeStateGainTax } from '../tax/state-tax';
import { ORDINARY_2026, LTCG_2026 } from '../tax/federal-2026';
import type { FilingStatus } from '../tax/types';

export const MS_PER_DAY = 86_400_000;

// Projected $/share at `saleDate`, compounding currentPrice at the annual
// growth rate. Returns currentPrice unchanged when growth=0 (preserves
// v1.5 behavior for callers who omit expectedAnnualGrowth).
export function projectPrice(currentPrice: number, growthAnnual: number, today: Date, saleDate: Date): number {
  if (growthAnnual === 0) return currentPrice;
  const yearsForward = Math.max(0, (saleDate.getTime() - today.getTime()) / (365.25 * MS_PER_DAY));
  return currentPrice * Math.pow(1 + growthAnnual, yearsForward);
}

// The earliest sale date that is LONG-TERM for a lot acquired on
// `acquisitionDate`. The holding period begins the day AFTER acquisition and
// long-term status requires holding MORE than one year, so a sale is
// long-term only from the day after the first anniversary. Calendar rule, not
// a fixed day count: a plain 365- or 366-day count misclassifies sales when a
// Feb 29 falls inside the one-year window (e.g. a sale exactly one year after
// a mid-2027 vest, across the 2028 leap day, is 366 days but still only one
// year — short-term). Last-day-of-month convention (Rev. Rul. 66-7): a Feb 29
// acquisition's anniversary lands on Feb 28 in a non-leap year, so it turns
// long-term on Mar 1.
export function longTermStartDate(acquisitionDate: Date): Date {
  const y = acquisitionDate.getUTCFullYear() + 1;
  const m = acquisitionDate.getUTCMonth();
  const d = acquisitionDate.getUTCDate();
  let anniv = new Date(Date.UTC(y, m, d));
  if (anniv.getUTCMonth() !== m) {
    // The day overflowed the target month (only Feb 29 -> non-leap Feb);
    // clamp to the last day of the intended month (day 0 of the next month).
    anniv = new Date(Date.UTC(y, m + 1, 0));
  }
  // Long-term begins the day after the anniversary ("more than one year").
  return new Date(anniv.getTime() + MS_PER_DAY);
}

export function isLongTermFor(acquisitionDate: Date, saleDate: Date): boolean {
  return saleDate.getTime() >= longTermStartDate(acquisitionDate).getTime();
}

// Total federal + state + NIIT on a full-year gain position (the cumulative
// long-term and short-term gain accumulators for one tax year), applying the
// real Schedule D treatment. Both the block-marginal functions below and the
// retained-liquidation backstop price a year by differencing this at two
// positions, so the tax law lives in exactly one place.
//
//   1. Schedule D cross-offset — a net loss in one character absorbs the net
//      gain in the other before either meets the bracket walker.
//   2. IRS Qualified Dividends & Capital Gain worksheet stacking — net
//      short-term gain is taxed as ordinary income from the ordinary base, and
//      the LTCG 0/15/20 cursor starts ABOVE ordinary income + short-term gain
//      (NOT long-term at the ordinary base with short-term stacked on top).
//   3. NIIT on the post-offset net investment income.
//   4. Per-bucket state tax on the post-netting remainders (same ST-first
//      stacking), so long-term-preference states see the right kind of gain.
//
// A net capital loss year returns zero here (the $3,000 ordinary offset and
// loss carryforward are plan-level concerns owned by the RSU lot-divest
// engine, not this single-year primitive).
export function computeYearGainTax(
  ordinaryIncome: number,
  longAccum: number,
  shortAccum: number,
  filingStatus: FilingStatus,
  stateCode: string,
): { federal: number; state: number; niit: number } {
  let nl = longAccum;
  let ns = shortAccum;
  if (nl < 0 && ns > 0) {
    const off = Math.min(-nl, ns);
    nl += off;
    ns -= off;
  } else if (ns < 0 && nl > 0) {
    const off = Math.min(-ns, nl);
    ns += off;
    nl -= off;
  }
  const remLong = Math.max(0, nl);
  const remShort = Math.max(0, ns);
  if (remLong <= 0 && remShort <= 0) return { federal: 0, state: 0, niit: 0 };

  const ordSchedule = ORDINARY_2026[filingStatus];
  const fedShort =
    walkOrdinaryBrackets(ordinaryIncome + remShort, ordSchedule) -
    walkOrdinaryBrackets(ordinaryIncome, ordSchedule);
  const fedLong = walkLtcgFederal(ordinaryIncome + remShort, remLong, LTCG_2026[filingStatus]);
  const federal = fedShort + fedLong;

  const niit = computeNiit(ordinaryIncome, remLong + remShort, filingStatus);

  const stateShort = computeStateGainTax({
    stateCode,
    ordinaryIncome,
    gainAmount: remShort,
    isLongTerm: false,
    filingStatus,
  });
  const stateLong = computeStateGainTax({
    stateCode,
    ordinaryIncome: ordinaryIncome + remShort,
    gainAmount: remLong,
    isLongTerm: true,
    filingStatus,
  });
  const state = stateShort + stateLong;

  return { federal, state, niit };
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

// Marginal tax for selling `deltaShares` more from `lotIdx` in year Y, given
// the year's running state: the delta in total (fed + state + NIIT) tax
// between the year position with and without this block. Signed — a loss
// block that offsets accumulated gain returns a NEGATIVE marginal tax (it
// removes tax), so a lowest-marginal-tax greedy can rank loss harvesting.
// Returns Infinity for a lot not yet acquired or already exhausted so the
// caller skips it.
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

  const oldLong = state.longTermGainSoFar;
  const oldShort = state.shortTermGainSoFar;
  const newLong = meta.isLongTerm ? oldLong + incrementalGain : oldLong;
  const newShort = meta.isLongTerm ? oldShort : oldShort + incrementalGain;

  const taxNew = computeYearGainTax(ordinaryIncome, newLong, newShort, filingStatus, stateCode);
  const taxOld = computeYearGainTax(ordinaryIncome, oldLong, oldShort, filingStatus, stateCode);
  return (
    taxNew.federal + taxNew.state + taxNew.niit - (taxOld.federal + taxOld.state + taxOld.niit)
  );
}

// Commit a block sale into the year state, returning the incremental federal /
// state / NIIT breakdown for reporting. Each component is the signed delta of
// the shared year-tax primitive, so a loss block reports the tax it REMOVES
// (negative) and the three components still sum to the year's true total tax.
//
// Because the components are signed, a per-sale row for a loss block committed
// AFTER same-year gain accumulates can show negative tax. Aggregate totals stay
// correct (the deltas telescope to the true year tax). In equity-funding this
// rarely surfaces — the greedy commits loss blocks first, where their marginal
// is ~0 — but a UI that must show non-negative per-row tax should reallocate the
// year's netted tax across the period's rows at report time rather than
// re-clamping here (re-clamping reintroduces the pre-phase-2 fed/NIIT split
// misreporting). See revision memo 148, Finding 2.
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

  const taxNew = computeYearGainTax(ordinaryIncome, newLong, newShort, filingStatus, stateCode);
  const taxOld = computeYearGainTax(ordinaryIncome, oldLong, oldShort, filingStatus, stateCode);

  state.longTermGainSoFar = newLong;
  state.shortTermGainSoFar = newShort;
  inventory[lotIdx].sharesRemaining -= deltaShares;

  return {
    federal: taxNew.federal - taxOld.federal,
    stateT: taxNew.state - taxOld.state,
    niit: taxNew.niit - taxOld.niit,
    gain: incrementalGain,
  };
}
