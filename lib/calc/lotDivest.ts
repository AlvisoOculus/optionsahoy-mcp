// AlphaLatitude Inc. © 2026
//
// RSU Lot Order Calculator engine (docs/tools/rsu-lot-order-spec.md §2.3).
// Given a set of vested lots and a divest target, choose WHICH lots and WHICH
// sale dates minimize total tax to divest that many shares — specific-lot
// identification + long-term deferral + multi-year bracket spreading.
//
// Objective: minimize total plan tax (federal + state + NIIT, with in-plan
// loss carryforward) to sell a fixed share count S, at a FLAT price. Gross is
// fixed by the flat price, so min-tax == max-after-tax. Pricing is
// PLAN-SCOPE: every candidate block is scored by its change in TOTAL plan tax
// across the chained horizon years (a gain absorbed into a loss year forfeits
// carryforward + the $3,000 ordinary offset), so gains and losses fold into
// one greedy and negative marginals are representable. The single-year tax law
// (Schedule D netting, IRS worksheet stacking, per-bucket state) lives in
// lotSelector.computeYearGainTax; this module adds the plan-level chain
// (carryforward with character + the $3,000 offset).

import {
  computeYearGainTax,
  isLongTermFor,
  longTermStartDate,
  MS_PER_DAY,
} from './lotSelector';
import { walkOrdinaryBrackets } from '../tax/bracket-walker';
import { computeStateGainTax } from '../tax/state-tax';
import { ORDINARY_2026 } from '../tax/federal-2026';
import type { FilingStatus } from '../tax/types';

export interface LotDivestLot {
  vestDate: Date;
  shares: number;
  costBasisPerShare: number;
}

export interface LotDivestInput {
  lots: LotDivestLot[];
  currentPrice: number;
  /** Fraction of total shares to divest, 0.10–1.0. */
  divestPercent: number;
  /** Tax years the plan may span: 1 ("sell all now"), 2, or 3. */
  horizonYears: 1 | 2 | 3;
  ordinaryIncome: number;
  filingStatus: FilingStatus;
  stateCode: string;
  today: Date;
}

export interface LotDivestSale {
  lotIndex: number;
  vestDate: Date;
  saleDate: Date;
  year: number;
  shares: number;
  grossProceeds: number;
  gainAmount: number;
  isLongTerm: boolean;
  /** Signed tax attributed to this row (a loss row shows the tax it removes). */
  taxAttributed: number;
}

export interface LotDivestYearGroup {
  year: number;
  sales: LotDivestSale[];
  netLong: number;
  netShort: number;
  tax: number;
  effectiveRate: number;
  carryforwardGenerated: number;
}

export interface DeferralCallout {
  lotIndex: number;
  longTermDate: Date;
  daysToWait: number;
  taxSaved: number;
  amountAtRisk: number;
}

export interface HorizonCard {
  horizonYears: number;
  totalTax: number;
  afterTaxKept: number;
}

export interface LotDivestResult {
  sharesToSell: number;
  totalShares: number;
  totalGross: number;
  totalTax: number;
  totalAfterTax: number;
  schedule: LotDivestYearGroup[];
  keptUnrealizedGain: number;
  carryforwardRemaining: number;
  /** delta = tax(FIFO same-schedule) − tax(plan) ≥ 0 (pure lot selection). */
  headlineAfterTaxKept: number;
  headlineDeltaVsFifo: number;
  /** Attribution chain (§4.3), all ≥ 0 by convention except spreadingDeferral. */
  attribution: { lotSelection: number; spreadingDeferral: number; total: number };
  horizonCards: HorizonCard[];
  deferralCallouts: DeferralCallout[];
}

// ---- plan-level tax with carryforward ------------------------------------

interface YearGain {
  year: number;
  long: number;
  short: number;
}

// Marginal ordinary-rate tax saved by deducting `amount` from ordinary income
// (the $3,000 net-capital-loss offset). Federal always; state via the same
// probe computeStateGainTax uses for ordinary income (over-credits the NJ/PA
// non-conforming class, which the UI discloses rather than models).
function ordinaryOffsetSaving(
  ordinaryIncome: number,
  amount: number,
  filingStatus: FilingStatus,
  stateCode: string,
): number {
  if (amount <= 0) return 0;
  const sched = ORDINARY_2026[filingStatus];
  const fed = walkOrdinaryBrackets(ordinaryIncome, sched) - walkOrdinaryBrackets(ordinaryIncome - amount, sched);
  const state = computeStateGainTax({
    stateCode,
    ordinaryIncome: ordinaryIncome - amount,
    gainAmount: amount,
    isLongTerm: false,
    filingStatus,
  });
  return fed + state;
}

interface PlanTaxYear {
  year: number;
  netLong: number;
  netShort: number;
  tax: number;
  carryforwardGenerated: number;
  /** Loss (<= 0) carried INTO this year, by character — needed so the schedule
   *  can attribute per-row tax against the same carryforward baseline the year
   *  subtotal used, and the rows reconcile with the header. */
  cfInLong: number;
  cfInShort: number;
}

// One tax year given the losses carried IN (by character) and this year's
// realized long/short gains. Schedule D: carried losses net against their own
// character first, then cross-offset; a net-loss year takes the $3,000 ordinary
// offset (ST loss first) and carries the remainder forward by character. This
// is the single source of the plan's per-year tax law — computePlanTax chains
// it, and buildSchedule differences it to attribute per-row tax so the rows
// reconcile with the year subtotal.
interface OneYearTax {
  tax: number;
  netLong: number;
  netShort: number;
  cfOutLong: number;
  cfOutShort: number;
  carryforwardGenerated: number;
}
function oneYearTax(
  cfInLong: number,
  cfInShort: number,
  yearLong: number,
  yearShort: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): OneYearTax {
  let nl = yearLong + cfInLong;
  let ns = yearShort + cfInShort;
  if (nl < 0 && ns > 0) {
    const o = Math.min(-nl, ns);
    nl += o;
    ns -= o;
  } else if (ns < 0 && nl > 0) {
    const o = Math.min(-ns, nl);
    ns += o;
    nl -= o;
  }
  if (nl >= 0 && ns >= 0) {
    const t = computeYearGainTax(ordinaryIncome, nl, ns, filingStatus, stateCode);
    return {
      tax: t.federal + t.state + t.niit,
      netLong: nl,
      netShort: ns,
      cfOutLong: 0,
      cfOutShort: 0,
      carryforwardGenerated: 0,
    };
  }
  // Net capital loss year.
  const netLoss = nl + ns; // <= 0
  const offset = Math.min(3000, -netLoss);
  let remShort = ns < 0 ? -ns : 0;
  let remLong = nl < 0 ? -nl : 0;
  let off = offset;
  const useShort = Math.min(off, remShort);
  remShort -= useShort;
  off -= useShort;
  const useLong = Math.min(off, remLong);
  remLong -= useLong;
  return {
    tax: -ordinaryOffsetSaving(ordinaryIncome, offset, filingStatus, stateCode),
    netLong: nl,
    netShort: ns,
    cfOutLong: -remLong,
    cfOutShort: -remShort,
    carryforwardGenerated: -netLoss - offset,
  };
}

// Total plan tax across the horizon years given each year's realized gains by
// character, chaining loss carryforward.
function computePlanTax(
  yearGains: YearGain[],
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): { total: number; perYear: PlanTaxYear[]; carryLong: number; carryShort: number } {
  let cfLong = 0;
  let cfShort = 0;
  let total = 0;
  const perYear: PlanTaxYear[] = [];
  for (const yg of yearGains) {
    const y = oneYearTax(cfLong, cfShort, yg.long, yg.short, ordinaryIncome, filingStatus, stateCode);
    total += y.tax;
    perYear.push({
      year: yg.year,
      netLong: y.netLong,
      netShort: y.netShort,
      tax: y.tax,
      carryforwardGenerated: y.carryforwardGenerated,
      cfInLong: cfLong,
      cfInShort: cfShort,
    });
    cfLong = y.cfOutLong;
    cfShort = y.cfOutShort;
  }
  return { total, perYear, carryLong: cfLong, carryShort: cfShort };
}

// ---- candidate sale dates -------------------------------------------------

interface Candidate {
  saleDate: Date;
  year: number;
  yearIdx: number;
}

function buildCandidates(input: LotDivestInput): Candidate[] {
  const y0 = input.today.getUTCFullYear();
  const years: number[] = [];
  for (let k = 0; k < input.horizonYears; k += 1) years.push(y0 + k);
  const yearIdxOf = (yr: number) => years.indexOf(yr);
  const horizonEnd = Date.UTC(y0 + input.horizonYears - 1, 11, 31);

  const seen = new Set<number>();
  const cands: Candidate[] = [];
  const push = (date: Date) => {
    const t = date.getTime();
    if (t < input.today.getTime() || t > horizonEnd) return;
    if (seen.has(t)) return;
    seen.add(t);
    const yr = date.getUTCFullYear();
    const yi = yearIdxOf(yr);
    if (yi < 0) return;
    cands.push({ saleDate: date, year: yr, yearIdx: yi });
  };

  push(new Date(input.today));
  // "Sell all now" (horizon 1) means TODAY — no waiting. Only multi-year plans
  // get later sale dates and the option to wait for a lot's long-term crossing.
  if (input.horizonYears > 1) {
    for (let k = 1; k < input.horizonYears; k += 1) push(new Date(Date.UTC(y0 + k, 0, 2)));
    // Each lot's long-term crossing date, so a near-long-term lot can wait.
    for (const lot of input.lots) {
      push(longTermStartDate(lot.vestDate));
    }
  }
  cands.sort((a, b) => a.saleDate.getTime() - b.saleDate.getTime());
  return cands;
}

// ---- greedy over (lot, candidate date) ------------------------------------

interface Assignment {
  // shares[lotIdx][candIdx]
  shares: number[][];
}

function emptyAssignment(nLots: number, nCands: number): Assignment {
  return { shares: Array.from({ length: nLots }, () => new Array<number>(nCands).fill(0)) };
}

function assignmentYearGains(
  assign: Assignment,
  input: LotDivestInput,
  cands: Candidate[],
  ltAt: boolean[][],
  years: number[],
): YearGain[] {
  const yg: YearGain[] = years.map((year) => ({ year, long: 0, short: 0 }));
  for (let li = 0; li < input.lots.length; li += 1) {
    const gainPerShare = input.currentPrice - input.lots[li].costBasisPerShare;
    for (let ci = 0; ci < cands.length; ci += 1) {
      const sh = assign.shares[li][ci];
      if (sh === 0) continue;
      const gain = sh * gainPerShare;
      const yi = cands[ci].yearIdx;
      if (ltAt[li][ci]) yg[yi].long += gain;
      else yg[yi].short += gain;
    }
  }
  return yg;
}

function planTaxTotal(
  yg: YearGain[],
  input: LotDivestInput,
): number {
  return computePlanTax(yg, input.ordinaryIncome, input.filingStatus, input.stateCode).total;
}

// Block-size cascade scaled to S so the commit count stays bounded (~S/coarse)
// regardless of position size: coarse ≈ the largest power of ten ≤ S/600, then
// refine down to single shares. Small positions run share-by-share; a million
// shares commit ~1,000-share blocks, not a million singles.
function blockCascade(S: number): number[] {
  let coarse = Math.floor(S / 600);
  coarse = coarse <= 1 ? 1 : Math.pow(10, Math.floor(Math.log10(coarse)));
  const out: number[] = [];
  for (let b = coarse; b >= 1; b = Math.floor(b / 10)) out.push(b);
  if (out[out.length - 1] !== 1) out.push(1);
  return out;
}

// Greedy: commit S shares as blocks minimizing ΔT_plan per share; ties to the
// earliest candidate date (candidates are pre-sorted). Losses fold in naturally
// (their ΔT is negative). The current assignment's per-year gains are tracked
// incrementally (`curYG`), so each candidate probe adjusts a single year cell
// and re-prices the plan instead of rescanning the whole grid. Post-greedy
// pairwise swap pass tidies obvious mis-placements.
function greedyAssign(
  input: LotDivestInput,
  cands: Candidate[],
  ltAt: boolean[][],
  years: number[],
  S: number,
): Assignment {
  const nLots = input.lots.length;
  const assign = emptyAssignment(nLots, cands.length);
  const inv = input.lots.map((l) => l.shares);
  const gps = input.lots.map((l) => input.currentPrice - l.costBasisPerShare);
  const curYG: YearGain[] = years.map((year) => ({ year, long: 0, short: 0 }));
  let committed = 0;
  const cascade = blockCascade(S);

  const runPass = (blockSize: number, isLast: boolean) => {
    let guard = 2_000_000;
    while (committed < S - 1e-9 && guard-- > 0) {
      const remaining = S - committed;
      // Non-final passes commit only FULL blocks, leaving the sub-block tail to
      // the finer passes (so refinement actually happens); the last pass takes
      // whatever remains (handles the fractional-share tail).
      if (!isLast && remaining < blockSize - 1e-9) break;
      const baseTax = planTaxTotal(curYG, input);
      let best: { li: number; ci: number; blk: number; per: number } | null = null;
      for (let li = 0; li < nLots; li += 1) {
        if (inv[li] <= 1e-9) continue;
        const blk = Math.min(blockSize, inv[li], remaining);
        if (blk <= 1e-9) continue;
        const gain = blk * gps[li];
        for (let ci = 0; ci < cands.length; ci += 1) {
          const yi = cands[ci].yearIdx;
          const lt = ltAt[li][ci];
          if (lt) curYG[yi].long += gain;
          else curYG[yi].short += gain;
          const per = (planTaxTotal(curYG, input) - baseTax) / blk;
          if (lt) curYG[yi].long -= gain;
          else curYG[yi].short -= gain;
          if (
            best === null ||
            per < best.per - 1e-9 ||
            (Math.abs(per - best.per) <= 1e-9 && ci < best.ci)
          ) {
            best = { li, ci, blk, per };
          }
        }
      }
      if (!best) break;
      const yi = cands[best.ci].yearIdx;
      const gain = best.blk * gps[best.li];
      if (ltAt[best.li][best.ci]) curYG[yi].long += gain;
      else curYG[yi].short += gain;
      assign.shares[best.li][best.ci] += best.blk;
      inv[best.li] -= best.blk;
      committed += best.blk;
    }
  };

  for (let i = 0; i < cascade.length; i += 1) runPass(cascade[i], i === cascade.length - 1);

  swapPass(assign, input, cands, ltAt, years, inv);
  return assign;
}

// Pairwise swap: try moving a small slice of each committed (lot,date) to a
// different (lot,date) if it lowers total plan tax. Cheap safety net for the
// greedy's non-convex loss/kink cases.
function swapPass(
  assign: Assignment,
  input: LotDivestInput,
  cands: Candidate[],
  ltAt: boolean[][],
  years: number[],
  inv: number[],
): void {
  const nLots = input.lots.length;
  const slice = 10;
  let improved = true;
  let guard = 5000;
  while (improved && guard-- > 0) {
    improved = false;
    const baseTax = planTaxTotal(assignmentYearGains(assign, input, cands, ltAt, years), input);
    for (let li = 0; li < nLots; li += 1) {
      for (let ci = 0; ci < cands.length; ci += 1) {
        const have = assign.shares[li][ci];
        if (have <= 1e-9) continue;
        const move = Math.min(slice, have);
        for (let lj = 0; lj < nLots; lj += 1) {
          for (let cj = 0; cj < cands.length; cj += 1) {
            if (lj === li && cj === ci) continue;
            if (inv[lj] < move - 1e-9) continue;
            assign.shares[li][ci] -= move;
            assign.shares[lj][cj] += move;
            const t = planTaxTotal(assignmentYearGains(assign, input, cands, ltAt, years), input);
            if (t < baseTax - 1e-6) {
              inv[li] += move;
              inv[lj] -= move;
              improved = true;
            } else {
              assign.shares[li][ci] += move;
              assign.shares[lj][cj] -= move;
            }
          }
          if (improved) break;
        }
        if (improved) break;
      }
      if (improved) break;
    }
  }
}

// FIFO assignment of a target per-date share vector, oldest lots first.
function fifoAssignForDateTotals(
  input: LotDivestInput,
  cands: Candidate[],
  dateTotals: number[],
): Assignment {
  const order = input.lots
    .map((l, i) => ({ i, t: l.vestDate.getTime() }))
    .sort((a, b) => a.t - b.t)
    .map((x) => x.i);
  const inv = input.lots.map((l) => l.shares);
  const assign = emptyAssignment(input.lots.length, cands.length);
  for (let ci = 0; ci < cands.length; ci += 1) {
    let need = dateTotals[ci];
    for (const li of order) {
      if (need <= 1e-9) break;
      const take = Math.min(need, inv[li]);
      if (take <= 1e-9) continue;
      assign.shares[li][ci] += take;
      inv[li] -= take;
      need -= take;
    }
  }
  return assign;
}

// ---- public entry ---------------------------------------------------------

function yearsFor(today: Date, horizonYears: number): number[] {
  const y0 = today.getUTCFullYear();
  const years: number[] = [];
  for (let k = 0; k < horizonYears; k += 1) years.push(y0 + k);
  return years;
}

interface Solved {
  S: number;
  years: number[];
  cands: Candidate[];
  ltAt: boolean[][];
  finalPlan: Assignment;
  planResult: ReturnType<typeof computePlanTax>;
  fifoSameTax: number;
  fifoAllTodayTax: number;
}

// Solve one horizon: greedy plan + FIFO baselines + the delta ≥ 0 guard. Both
// the main result and each horizon card call this, so there is one copy of the
// solve (no drift between a "core" and the full entry).
function solveHorizon(input: LotDivestInput): Solved {
  const totalShares = input.lots.reduce((a, l) => a + l.shares, 0);
  const S = Math.max(1, Math.min(totalShares, input.divestPercent * totalShares));
  const years = yearsFor(input.today, input.horizonYears);
  const cands = buildCandidates(input);
  const ltAt = input.lots.map((lot) => cands.map((c) => isLongTermFor(lot.vestDate, c.saleDate)));

  const plan = greedyAssign(input, cands, ltAt, years, S);
  const dateTotals = cands.map((_, ci) => plan.shares.reduce((a, row) => a + row[ci], 0));
  const fifoSameDates = fifoAssignForDateTotals(input, cands, dateTotals);
  // candidates[0] is always `today` (pushed first, the earliest timestamp).
  const fifoAllToday = fifoAssignForDateTotals(input, cands, cands.map((_, ci) => (ci === 0 ? S : 0)));

  const taxOf = (a: Assignment) => planTaxTotal(assignmentYearGains(a, input, cands, ltAt, years), input);
  const planTax = taxOf(plan);
  const fifoSameTax = taxOf(fifoSameDates);
  const fifoAllTodayTax = taxOf(fifoAllToday);

  // Headline delta ≥ 0 guard: adopt FIFO-same-schedule if it prices below the plan.
  const finalPlan = fifoSameTax < planTax - 1e-6 ? fifoSameDates : plan;
  const planResult = computePlanTax(
    assignmentYearGains(finalPlan, input, cands, ltAt, years),
    input.ordinaryIncome,
    input.filingStatus,
    input.stateCode,
  );
  return { S, years, cands, ltAt, finalPlan, planResult, fifoSameTax, fifoAllTodayTax };
}

export function computeLotDivestPlan(input: LotDivestInput): LotDivestResult {
  const totalShares = input.lots.reduce((a, l) => a + l.shares, 0);
  const solved = solveHorizon(input);
  const { S, years, cands, ltAt, finalPlan, planResult, fifoSameTax, fifoAllTodayTax } = solved;
  const planTax = planResult.total;

  const gross = S * input.currentPrice;
  const afterTax = gross - planTax;

  const schedule = buildSchedule(finalPlan, input, cands, ltAt, years, planResult);

  // Kept unrealized gain (retained shares at flat price).
  const soldByLot = finalPlan.shares.map((row) => row.reduce((a, b) => a + b, 0));
  let keptUnrealized = 0;
  for (let li = 0; li < input.lots.length; li += 1) {
    keptUnrealized += (input.lots[li].shares - soldByLot[li]) * (input.currentPrice - input.lots[li].costBasisPerShare);
  }
  keptUnrealized = Math.max(0, keptUnrealized);

  const cfRemaining = -(planResult.carryLong + planResult.carryShort);

  // Attribution chain (§4.3): lotSelection == the headline delta (≥ 0 by the guard).
  const lotSelection = Math.max(0, fifoSameTax - planTax);
  const attribution = {
    lotSelection,
    spreadingDeferral: fifoAllTodayTax - fifoSameTax,
    total: fifoAllTodayTax - planTax,
  };

  // Horizon cards: re-solve at 1/2/3 years (reuse the main solve for the match).
  const horizonCards: HorizonCard[] = ([1, 2, 3] as const).map((h) => {
    const r = h === input.horizonYears ? solved : solveHorizon({ ...input, horizonYears: h });
    const grossH = r.S * input.currentPrice;
    return { horizonYears: h, totalTax: r.planResult.total, afterTaxKept: grossH - r.planResult.total };
  });

  return {
    sharesToSell: S,
    totalShares,
    totalGross: gross,
    totalTax: planTax,
    totalAfterTax: afterTax,
    schedule,
    keptUnrealizedGain: keptUnrealized,
    carryforwardRemaining: cfRemaining,
    headlineAfterTaxKept: afterTax,
    headlineDeltaVsFifo: lotSelection,
    attribution,
    horizonCards,
    deferralCallouts: buildDeferralCallouts(finalPlan, input, cands, ltAt),
  };
}

function buildSchedule(
  assign: Assignment,
  input: LotDivestInput,
  cands: Candidate[],
  ltAt: boolean[][],
  years: number[],
  planResult: ReturnType<typeof computePlanTax>,
): LotDivestYearGroup[] {
  const groups: LotDivestYearGroup[] = [];

  for (let yi = 0; yi < years.length; yi += 1) {
    const py = planResult.perYear[yi];
    const rows = [];
    for (let li = 0; li < input.lots.length; li += 1) {
      const gps = input.currentPrice - input.lots[li].costBasisPerShare;
      for (let ci = 0; ci < cands.length; ci += 1) {
        if (cands[ci].yearIdx !== yi) continue;
        const sh = assign.shares[li][ci];
        if (sh <= 1e-9) continue;
        rows.push({ li, ci, shares: sh, gain: sh * gps, isLT: ltAt[li][ci] });
      }
    }
    if (rows.length === 0) continue;
    // Gains before losses, then earlier date, then lot index — so a loss row
    // shows the tax it removes against the gains it offsets.
    rows.sort((a, b) => {
      const ag = a.gain < 0 ? 1 : 0;
      const bg = b.gain < 0 ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (a.ci !== b.ci) return a.ci - b.ci;
      return a.li - b.li;
    });

    // Attribute the year's true tax across rows by differencing the SAME
    // carryforward-aware year-tax the subtotal uses (oneYearTax seeded with the
    // year's incoming carryforward), so the rows telescope to group.tax exactly.
    let accLong = 0;
    let accShort = 0;
    const yTax = (l: number, s: number) =>
      oneYearTax(py.cfInLong, py.cfInShort, l, s, input.ordinaryIncome, input.filingStatus, input.stateCode).tax;
    // Seed at 0 (not yTax(0,0)) so the row attributions telescope to the FULL
    // year tax py.tax = yTax(fullLong, fullShort). Any incoming-carryforward
    // effect folds into the first row rather than being left unattributed, and
    // the column sums to the year subtotal the user sees.
    let prev = 0;
    const sales = rows.map((r) => {
      if (r.isLT) accLong += r.gain;
      else accShort += r.gain;
      const now = yTax(accLong, accShort);
      const attributed = now - prev;
      prev = now;
      return {
        lotIndex: r.li,
        vestDate: input.lots[r.li].vestDate,
        saleDate: cands[r.ci].saleDate,
        year: years[yi],
        shares: r.shares,
        grossProceeds: r.shares * input.currentPrice,
        gainAmount: r.gain,
        isLongTerm: r.isLT,
        taxAttributed: attributed,
      };
    });
    const grossThisYear = rows.reduce((a, r) => a + r.shares * input.currentPrice, 0);
    groups.push({
      year: years[yi],
      sales,
      netLong: py.netLong,
      netShort: py.netShort,
      tax: py.tax,
      effectiveRate: grossThisYear > 0 ? py.tax / grossThisYear : 0,
      carryforwardGenerated: py.carryforwardGenerated,
    });
  }
  return groups;
}

function buildDeferralCallouts(
  assign: Assignment,
  input: LotDivestInput,
  cands: Candidate[],
  ltAt: boolean[][],
): DeferralCallout[] {
  const out: DeferralCallout[] = [];
  for (let li = 0; li < input.lots.length; li += 1) {
    // Any shares of this lot sold SHORT-TERM that could have waited for LT?
    const ltStart = longTermStartDate(input.lots[li].vestDate);
    let stShares = 0;
    let earliestStDate: Date | null = null;
    for (let ci = 0; ci < cands.length; ci += 1) {
      const sh = assign.shares[li][ci];
      if (sh <= 1e-9) continue;
      if (!ltAt[li][ci]) {
        stShares += sh;
        if (!earliestStDate || cands[ci].saleDate < earliestStDate) earliestStDate = cands[ci].saleDate;
      }
    }
    if (stShares <= 1e-9 || !earliestStDate) continue;
    // Only surface if the long-term date is reasonably close (within ~120 days)
    // AND falls inside the plan's own horizon — never suggest waiting into a tax
    // year the chosen horizon excludes (which would break the "sell within
    // horizon" premise).
    const horizonEnd = Date.UTC(input.today.getUTCFullYear() + input.horizonYears - 1, 11, 31);
    if (ltStart.getTime() > horizonEnd) continue;
    const daysToWait = Math.ceil((ltStart.getTime() - earliestStDate.getTime()) / MS_PER_DAY);
    if (daysToWait <= 0 || daysToWait > 120) continue;
    const gainPerShare = input.currentPrice - input.lots[li].costBasisPerShare;
    if (gainPerShare <= 0) continue; // no ST->LT benefit on a loss lot
    // Tax saved ≈ (ordinary marginal − LTCG marginal) on the ST gain. Estimate
    // via the difference of a short vs long block at the user's income.
    const gain = stShares * gainPerShare;
    const asShort = computeYearGainTax(input.ordinaryIncome, 0, gain, input.filingStatus, input.stateCode);
    const asLong = computeYearGainTax(input.ordinaryIncome, gain, 0, input.filingStatus, input.stateCode);
    const saved =
      asShort.federal + asShort.state + asShort.niit - (asLong.federal + asLong.state + asLong.niit);
    if (saved <= 0) continue;
    out.push({
      lotIndex: li,
      longTermDate: ltStart,
      daysToWait,
      taxSaved: saved,
      amountAtRisk: stShares * input.currentPrice,
    });
  }
  return out;
}
