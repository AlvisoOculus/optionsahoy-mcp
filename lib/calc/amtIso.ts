// AlphaLatitude Inc. © 2026
//
// AMT + ISO Exercise Calculator orchestrator.
// Pure functions — no I/O, no state. Re-runs synchronously on input change.
//
// MODEL ASSUMPTIONS (matching docs/tools/amt-iso-calculator-spec.md §10):
//   - Exercise-and-hold (no disqualifying dispositions). Bargain element only
//     affects AMT, not regular tax.
//   - FMV held flat across the horizon.
//   - Ordinary income held flat across the horizon (no career trajectory).
//   - State of residence is constant.
//   - Federal AMT credit recovers across years; state AMT credit does NOT in
//     v1 (simplification — state credit recovery is dollar-small relative to
//     federal and adds complexity for the optimizer). Documented in disclaimer.

import {
  computeFederalGainTax,
  sliceBracketsAcrossDelta,
  walkOrdinaryBrackets,
} from '@/lib/tax/bracket-walker';
import { ORDINARY_2026 } from '@/lib/tax/federal-2026';
import {
  AMT_BREAKPOINT_2026,
  AMT_RATES,
  amtExemption,
  tentativeMinimumTax,
} from '@/lib/tax/federal-amt-2026';
import { computeStateGainTax, getStateBrackets } from '@/lib/tax/state-tax';
import {
  hasStateAmt,
  stateAmtLineItems,
  stateTentativeMinimumTax,
} from '@/lib/tax/state-amt';
import type { TaxBreakdownRow } from '@/lib/calc/concentration';
import type { FilingStatus } from '@/lib/tax/types';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface AmtIsoInput {
  shares: number;             // total ISOs to exercise across horizon
  strike: number;             // $/share
  fmv: number;                // $/share TODAY (year 1)
  expectedGrowth: number;     // arithmetic-mean annual growth rate (the user's
                              // input), e.g. 0.10 for 10%/yr. The tool subtracts
                              // σ²/2 (volatility drag) before projecting FMV
                              // forward, so this field stays "what the user
                              // expects on average" rather than "what the
                              // median path will realize."
  volatilityDrag: number;     // multiplicative haircut at the planning horizon
                              // (1 − exp(−σ²·horizon/2)). 0 disables drag. 20%
                              // default (matches NSO). Auto-fills from the chain's
                              // ATM IV when a public ticker is set. Stored as the
                              // haircut so the slider mirrors NSO's UX.
  filingStatus: FilingStatus;
  ordinaryIncome: number;
  stateCode: string;          // 2-letter; use 'CA' style
  carryforwardCredit: number; // existing federal AMT credit from prior years
  horizon: number;            // 1..10
  cashReturnRate: number;     // annual after-tax return on idle cash, used to
                              // time-value AMT premiums paid early (opportunity
                              // cost) and credit recoveries that land late. UI
                              // default 5% (≈ short-Treasury yield). At 0 the
                              // NTV functions collapse back to the prior
                              // nominal-sum behavior, preserving v1 tests.
  grantDate: Date;            // ISO grant date (drives 10y expiration + 2y QD)
  hasLeftCompany: boolean;
  terminationDate: Date | null; // only meaningful when hasLeftCompany === true
}

export interface TimingFlags {
  grantExpiration: Date;       // grantDate + 10y (IRC §422 max term for ISOs)
  qdEligibleDate: Date;        // grantDate + 2y (qualifying-disposition gate)
  exerciseWindowClose: Date | null; // terminationDate + 90d, null when employed
  maxHorizon: number;          // 1..10 capped by binding constraint (grant 10y expiry; departed 90d window)
  daysUntilWindowClose: number | null; // null when still employed; can be negative
  windowClosed: boolean;       // departed + deadline already past
  qdNotYetEligible: boolean;   // grantDate + 2y is in the future
}

const MS_PER_DAY = 86_400_000;
const POST_TERM_EXERCISE_DAYS = 90;
const ISO_GRANT_TERM_YEARS = 10;
const QD_GRANT_HOLDING_YEARS = 2;

function addYears(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  out.setFullYear(out.getFullYear() + years);
  return out;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

// Complete calendar years between two dates (later-earlier), >= 0. Floors
// at 0 if `later` <= `earlier`. Day-of-year rule: subtract one if `later`
// hasn't yet reached `earlier`'s anniversary.
function completeYearsBetween(earlier: Date, later: Date): number {
  if (later.getTime() <= earlier.getTime()) return 0;
  let years = later.getUTCFullYear() - earlier.getUTCFullYear();
  const monthDiff = later.getUTCMonth() - earlier.getUTCMonth();
  const dayDiff = later.getUTCDate() - earlier.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years -= 1;
  return Math.max(0, years);
}

export function computeTimingFlags(input: AmtIsoInput, today: Date): TimingFlags {
  const grantExpiration = addYears(input.grantDate, ISO_GRANT_TERM_YEARS);
  const qdEligibleDate = addYears(input.grantDate, QD_GRANT_HOLDING_YEARS);
  const qdNotYetEligible = qdEligibleDate.getTime() > today.getTime();

  let exerciseWindowClose: Date | null = null;
  let daysUntilWindowClose: number | null = null;
  let windowClosed = false;

  if (input.hasLeftCompany && input.terminationDate) {
    exerciseWindowClose = addDays(input.terminationDate, POST_TERM_EXERCISE_DAYS);
    daysUntilWindowClose = Math.ceil(
      (exerciseWindowClose.getTime() - today.getTime()) / MS_PER_DAY,
    );
    windowClosed = daysUntilWindowClose <= 0;
  }

  // Binding deadline = the earlier of grant expiration and (post-term window
  // close, if departed). Convert to whole-year horizon, floored at 1.
  const bindingDeadline =
    exerciseWindowClose && exerciseWindowClose.getTime() < grantExpiration.getTime()
      ? exerciseWindowClose
      : grantExpiration;
  // Calendar-aware complete-years count. Using ms / 365.25 underflows by a
  // fraction of a day across leap years (e.g. 9 calendar years from a
  // non-leap May span 2 leap days → 3287 days → 8.998 years → floor 8),
  // which silently truncates the slider.
  const yearsUntilDeadline = completeYearsBetween(today, bindingDeadline);
  let maxHorizon = Math.max(1, Math.min(10, yearsUntilDeadline));
  if (windowClosed) maxHorizon = 1; // calculator becomes informational; lock to 1
  // Departed users with an open window are inside the 90-day grace — force
  // lump-sum-only mode (1 year horizon).
  if (input.hasLeftCompany && !windowClosed) maxHorizon = 1;

  return {
    grantExpiration,
    qdEligibleDate,
    exerciseWindowClose,
    maxHorizon,
    daysUntilWindowClose,
    windowClosed,
    qdNotYetEligible,
  };
}

// Future-value of the AMT premium stream from a schedule, evaluated at the
// horizon at input.cashReturnRate. The per-year premium is the cash tax above
// what regular tax would have charged that year (positive when AMT > regular,
// negative in credit-recovery years where the credit pushed cash tax below
// the regular floor). Year i (0-based) compounds for T-1-i years.
//
// At cashReturnRate=0 this collapses to schedule.exerciseTax (nominal sum),
// which is how the v1 calc treated every dollar.
export function futureValueExerciseTax(
  schedule: Schedule,
  cashReturnRate: number,
  horizon: number,
): number {
  const T = Math.max(1, horizon);
  let total = 0;
  for (let i = 0; i < schedule.years.length; i++) {
    const y = schedule.years[i];
    const premium = y.cashTax - (y.regularFederal + y.regularState);
    const yearsToHorizon = Math.max(0, T - 1 - i);
    total += premium * Math.pow(1 + cashReturnRate, yearsToHorizon);
  }
  return total;
}

// After-tax dollars at horizon for a multi-year schedule. Assumes all shares
// are sold at the horizon as a qualifying disposition (basis = strike, gain
// taxed at LTCG). Gross sale value is constant across schedules with the same
// input. AMT premiums are future-valued to the horizon at
// input.cashReturnRate so an early lump-sum premium is correctly penalized
// against a later spread one. At cashReturnRate=0 the math is identical to
// the v1 nominal model.
export function netFinalValue(schedule: Schedule, input: AmtIsoInput): number {
  return nfvBreakdown(schedule, input).nfv;
}

export interface NfvBreakdown {
  grossGain: number;        // shares × (futureFmv − strike), the LTCG-eligible gain
  federalLTCG: number;      // federal LTCG tax (incl. NIIT) on grossGain
  stateLTCG: number;        // state LTCG tax on grossGain
  amtPremiumFV: number;     // future-valued AMT premium stream (above baseline regular tax)
  nfv: number;              // grossGain − federalLTCG − stateLTCG − amtPremiumFV
}

// Decomposed view of netFinalValue's components. Used in the UI to show the
// reader exactly which taxes are netted out of the headline NFV number.
export function nfvBreakdown(schedule: Schedule, input: AmtIsoInput): NfvBreakdown {
  const T = Math.max(1, input.horizon);
  const g = effectiveAnnualGrowth(input);
  const futureFmv = input.fmv * Math.pow(1 + g, T);
  const grossGain = input.shares * (futureFmv - input.strike);
  const amtPremiumFV = futureValueExerciseTax(schedule, input.cashReturnRate, T);
  if (grossGain <= 0) {
    return { grossGain, federalLTCG: 0, stateLTCG: 0, amtPremiumFV, nfv: -amtPremiumFV };
  }
  const federalLTCG = computeFederalGainTax({
    ordinaryIncome: input.ordinaryIncome,
    gainAmount: grossGain,
    isLongTerm: true,
    filingStatus: input.filingStatus,
  });
  const stateLTCG = computeStateGainTax({
    stateCode: input.stateCode,
    ordinaryIncome: input.ordinaryIncome,
    gainAmount: grossGain,
    isLongTerm: true,
    filingStatus: input.filingStatus,
  });
  return {
    grossGain,
    federalLTCG,
    stateLTCG,
    amtPremiumFV,
    nfv: grossGain - federalLTCG - stateLTCG - amtPremiumFV,
  };
}

// Running net-final-value through each year y of a Schedule, defined as
// (shares exercised through year y) × per-share-NTV-at-horizon minus the
// future-valued AMT premium stream paid through year y. At y = horizon this
// matches netFinalValue() exactly. Useful as a "value locked in by year y"
// line chart; lines can rise from credit recovery in later years.
export function cumulativeNetFinalValue(schedule: Schedule, input: AmtIsoInput): number[] {
  const T = Math.max(1, input.horizon);
  const g = effectiveAnnualGrowth(input);
  const futureFmv = input.fmv * Math.pow(1 + g, T);
  const grossPerShare = Math.max(0, futureFmv - input.strike);
  let cumShares = 0;
  let cumFvTax = 0;
  return schedule.years.map((y, i) => {
    cumShares += y.shares;
    const premium = y.cashTax - (y.regularFederal + y.regularState);
    const yearsToHorizon = Math.max(0, T - 1 - i);
    cumFvTax += premium * Math.pow(1 + input.cashReturnRate, yearsToHorizon);
    const grossGain = cumShares * grossPerShare;
    if (grossGain <= 0) return -cumFvTax;
    const fed = computeFederalGainTax({
      ordinaryIncome: input.ordinaryIncome,
      gainAmount: grossGain,
      isLongTerm: true,
      filingStatus: input.filingStatus,
    });
    const state = computeStateGainTax({
      stateCode: input.stateCode,
      ordinaryIncome: input.ordinaryIncome,
      gainAmount: grossGain,
      isLongTerm: true,
      filingStatus: input.filingStatus,
    });
    return grossGain - fed - state - cumFvTax;
  });
}

// Bracket-walked rows for federal + state regular tax.
export function regularTaxBreakdownRows(
  ordinaryIncome: number,
  filingStatus: FilingStatus,
  stateCode: string,
): TaxBreakdownRow[] {
  const rows: TaxBreakdownRow[] = [];
  const fedSlices = sliceBracketsAcrossDelta(0, ordinaryIncome, ORDINARY_2026[filingStatus]);
  for (const s of fedSlices) {
    if (s.tax > 0) rows.push({ label: 'Federal', rate: s.rate, amount: s.amount, tax: s.tax });
  }
  const stateBrackets = getStateBrackets(stateCode, filingStatus);
  if (stateBrackets) {
    const slices = sliceBracketsAcrossDelta(0, ordinaryIncome, stateBrackets);
    for (const s of slices) {
      if (s.tax > 0) rows.push({ label: stateCode, rate: s.rate, amount: s.amount, tax: s.tax });
    }
  }
  return rows;
}

// Slice rows for the AMT computation: federal 26%/28% on taxable excess,
// state flat rate above its exemption.
export function amtTaxBreakdownRows(
  amti: number,
  filingStatus: FilingStatus,
  stateCode: string,
): TaxBreakdownRow[] {
  const rows: TaxBreakdownRow[] = [];
  const fedExemption = amtExemption(amti, filingStatus);
  const fedTaxable = Math.max(0, amti - fedExemption);
  if (fedTaxable > 0) {
    const lower = Math.min(fedTaxable, AMT_BREAKPOINT_2026);
    rows.push({ label: 'Federal AMT', rate: AMT_RATES.lower, amount: lower, tax: lower * AMT_RATES.lower });
    if (fedTaxable > AMT_BREAKPOINT_2026) {
      const upper = fedTaxable - AMT_BREAKPOINT_2026;
      rows.push({ label: 'Federal AMT', rate: AMT_RATES.upper, amount: upper, tax: upper * AMT_RATES.upper });
    }
  }
  rows.push(...stateAmtLineItems(stateCode, amti, filingStatus));
  return rows;
}

// Per-share bargain element in year `year` (1-indexed). Year 1 = today's
// FMV; later years compound at the vol-drag-adjusted growth rate.
export function bargainPerShareForYear(input: AmtIsoInput, year: number): number {
  const g = effectiveAnnualGrowth(input);
  const fmvY = input.fmv * Math.pow(1 + g, year - 1);
  return Math.max(0, fmvY - input.strike);
}

// Storing drag (not σ) matches the NSO/RSU UX. Invert it to a per-year
// σ²/2 and subtract from the user's arithmetic-mean expectedGrowth.
function effectiveAnnualGrowth(input: AmtIsoInput): number {
  const drag = input.volatilityDrag;
  if (!Number.isFinite(drag) || drag <= 0) return input.expectedGrowth;
  const safeDrag = Math.min(0.99, Math.max(0, drag)); // log(0) guard
  const T = Math.max(1, input.horizon);
  return input.expectedGrowth - -Math.log(1 - safeDrag) / T;
}

export interface YearTax {
  year: number;             // 1-indexed
  shares: number;
  bargain: number;
  regularFederal: number;
  regularState: number;
  tmtFederal: number;
  tmtState: number;
  amtOwedFederal: number;
  amtOwedState: number;
  creditRecovered: number;  // federal AMT credit applied this year
  cashTax: number;          // federal + state, net of credit recovery
}

export type ScheduleLabel = 'lump_sum' | 'even_split' | 'optimized';

export interface Schedule extends NfvBreakdown {
  label: ScheduleLabel;
  years: YearTax[];
  totalTax: number;
  // Tax the user would owe with NO exercise (regular fed + state on ordinary
  // income alone, summed across the horizon). Constant across plans for the
  // same input. Computed as years[0]'s regular × horizon — assumes ordinary
  // income is held flat across years (true under the current model; revisit
  // if the calculator ever models year-varying ordinary income).
  baselineRegularTax: number;
  // totalTax − baselineRegularTax. The marginal cost of exercising — what
  // the optimizer actually minimizes.
  exerciseTax: number;
  creditEarned: number;
  creditRecovered: number;
  creditRemaining: number;
}

export interface AmtIsoResult {
  // Single-year answer (the SEO-popular crossover question)
  crossoverShares: number;        // max whole shares to exercise this year before federal AMT > 0
  crossoverBargain: number;       // = crossoverShares × (fmv − strike)
  alreadyInAmt: boolean;          // true if regular tax < tmt with 0 bargain (rare)

  // Multi-year plans (run at effectiveHorizon, clamped to maxHorizon)
  schedules: {
    lumpSum: Schedule;
    evenSplit: Schedule;
    optimized: Schedule;
  };

  // Display flags
  stateHasAmt: boolean;
  bargainPerShare: number;
  timing: TimingFlags;
  effectiveHorizon: number;       // min(input.horizon, timing.maxHorizon)

  // Departed-user partial-exercise recommendation. Populated only when
  // hasLeftCompany=true and the post-termination window is still open. The
  // optimizer scans Q ∈ [0, shares] and picks the count that maximizes
  // expected after-tax NPV at the user's hold horizon.
  departedRecommendation?: DepartedRecommendation;
}

export interface DepartedRecommendation {
  recommendedShares: number;          // Q*
  recommendedExerciseTax: number;     // AMT cost at Q*
  recommendedNetValue: number;        // expected after-tax value at horizon
  fullExerciseShares: number;         // = input.shares
  fullExerciseTax: number;            // AMT cost if Q = N
  fullExerciseNetValue: number;       // value if Q = N
  holdYears: number;                  // post-exercise hold horizon used
  futureFmvPerShare: number;          // fmv × (1+g)^holdYears
  // Year-by-year tax schedule for the recommended Q: year 1 = lump
  // exercise of Q*, years 2..holdYears = 0 exercise (credit recovers as
  // regular tax exceeds tentative AMT).
  recommendedSchedule: Schedule;
  // Q-vs-NPV curve for the chart. Sampled uniformly across [0, N].
  curve: { shares: number; netValue: number; exerciseTax: number }[];
}

// ---------------------------------------------------------------
// Per-year computation
// ---------------------------------------------------------------

interface YearContext {
  ordinaryIncome: number;
  filingStatus: FilingStatus;
  stateCode: string;
  regularFederal: number;
  regularState: number;
}

function buildYearContext(input: AmtIsoInput): YearContext {
  const regularFederal = walkOrdinaryBrackets(
    input.ordinaryIncome,
    ORDINARY_2026[input.filingStatus],
  );
  const stateBrackets = getStateBrackets(input.stateCode, input.filingStatus);
  const regularState = stateBrackets
    ? walkOrdinaryBrackets(input.ordinaryIncome, stateBrackets)
    : 0;
  return {
    ordinaryIncome: input.ordinaryIncome,
    filingStatus: input.filingStatus,
    stateCode: input.stateCode,
    regularFederal,
    regularState,
  };
}

function computeYearTax(
  yearIndex: number,        // 1-indexed
  shares: number,
  bargainPerShare: number,
  ctx: YearContext,
  creditBalance: number,
): YearTax {
  const bargain = shares * bargainPerShare;
  const amti = ctx.ordinaryIncome + bargain;
  const tmtFederal = tentativeMinimumTax(amti, ctx.filingStatus);
  const tmtState = stateTentativeMinimumTax(ctx.stateCode, amti, ctx.filingStatus);
  const amtOwedFederal = Math.max(0, tmtFederal - ctx.regularFederal);
  const amtOwedState = Math.max(0, tmtState - ctx.regularState);

  // Credit recovery: only positive when regular > tmt federally (i.e., AMT not
  // owed this year). Capped by both credit balance and the regular−tmt headroom.
  const headroom = Math.max(0, ctx.regularFederal - tmtFederal);
  const creditRecovered = Math.min(creditBalance, headroom);

  const cashTax =
    ctx.regularFederal +
    ctx.regularState +
    amtOwedFederal +
    amtOwedState -
    creditRecovered;

  return {
    year: yearIndex,
    shares,
    bargain,
    regularFederal: ctx.regularFederal,
    regularState: ctx.regularState,
    tmtFederal,
    tmtState,
    amtOwedFederal,
    amtOwedState,
    creditRecovered,
    cashTax,
  };
}

// ---------------------------------------------------------------
// Crossover (single-year answer)
// ---------------------------------------------------------------

/**
 * Federal AMT crossover bargain: largest bargain element such that
 * tmt(ordinary + B) ≤ regular_tax. Above this, AMT > 0.
 *
 * Bisection rather than closed-form: TMT is piecewise linear with kinks at
 * the phaseout threshold, complete-phaseout point, and 26%/28% breakpoint —
 * a closed-form per-segment solver works but is brittle when the data
 * constants change. Bisection is robust, and 50 iterations gets sub-cent
 * precision in <1ms.
 */
export function findCrossoverBargain(input: AmtIsoInput): {
  crossoverBargain: number;
  alreadyInAmt: boolean;
} {
  const ctx = buildYearContext(input);
  // TMT(ordinary + 0) — if already > regular, no crossover (any exercise adds AMT).
  const tmtAtZero = tentativeMinimumTax(ctx.ordinaryIncome, ctx.filingStatus);
  if (tmtAtZero >= ctx.regularFederal) {
    return { crossoverBargain: 0, alreadyInAmt: tmtAtZero > ctx.regularFederal };
  }

  let lo = 0;
  let hi = 50_000_000; // a $50M bargain element sanity cap; far above any realistic input
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const tmt = tentativeMinimumTax(ctx.ordinaryIncome + mid, ctx.filingStatus);
    if (tmt <= ctx.regularFederal) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { crossoverBargain: lo, alreadyInAmt: false };
}

// ---------------------------------------------------------------
// Schedule runner
// ---------------------------------------------------------------

export function runSchedule(
  label: ScheduleLabel,
  sharesPerYear: number[],
  input: AmtIsoInput,
): Schedule {
  const ctx = buildYearContext(input);

  let creditBalance = input.carryforwardCredit;
  let creditEarned = 0;
  let creditRecovered = 0;
  let totalTax = 0;
  const years: YearTax[] = [];

  for (let i = 0; i < sharesPerYear.length; i++) {
    const bps = bargainPerShareForYear(input, i + 1);
    const yearTax = computeYearTax(i + 1, sharesPerYear[i], bps, ctx, creditBalance);
    years.push(yearTax);
    creditBalance += yearTax.amtOwedFederal - yearTax.creditRecovered;
    creditEarned += yearTax.amtOwedFederal;
    creditRecovered += yearTax.creditRecovered;
    totalTax += yearTax.cashTax;
  }

  const baselineRegularTax =
    years.length > 0
      ? (years[0].regularFederal + years[0].regularState) * years.length
      : 0;

  // nfvBreakdown only needs schedule.years[] (via futureValueExerciseTax) to
  // compute amtPremiumFV — safe to call before the NFV fields are filled.
  const base = {
    label,
    years,
    totalTax,
    baselineRegularTax,
    exerciseTax: totalTax - baselineRegularTax,
    creditEarned,
    creditRecovered,
    creditRemaining: Math.max(0, creditBalance),
  };
  const breakdown = nfvBreakdown(base as Schedule, input);
  return { ...base, ...breakdown };
}

// ---------------------------------------------------------------
// Multi-year optimizer (grid search)
// ---------------------------------------------------------------

// Discretization for the share-allocation grid. Wider horizons explode the
// search space combinatorially (C(N+H−1, H−1) leaves), so we lower
// granularity as H grows. Branch-and-bound (seeded with the better of
// lump-sum and even-split) prunes most leaves in practice; these caps are
// chosen so the worst-case leaf count stays manageable in-browser:
//   H=3, g=100 → 5K leaves        (<10ms)
//   H=5, g=50  → 320K leaves      (~30ms)
//   H=7, g=30  → ~1.5M leaves     (~100ms)
//   H=10, g=20 → ~10M leaves WC, typically 100s of K with pruning (~150ms)
function gridGranularity(horizon: number): number {
  if (horizon <= 3) return 100;
  if (horizon === 4) return 60;
  if (horizon === 5) return 50;
  if (horizon <= 7) return 25;
  return 20;
}

/**
 * Find the cheapest split of `total` shares across `horizon` years.
 * Discretize into GRID_GRANULARITY chunks; enumerate all compositions of
 * GRID_GRANULARITY into `horizon` non-negative parts via DP.
 *
 * State space = C(GRID_GRANULARITY + horizon − 1, horizon − 1).
 * For (granularity=100, horizon=5): C(104, 4) = 4.5M — too many to brute force.
 * DP: dp[year][remaining_chunks] = best total tax + corresponding split.
 * Per cell we try at most (remaining_chunks + 1) decisions; total work
 * O(horizon × granularity²) ≈ 5 × 10,000 = 50K cells. Each cell evaluates
 * the per-year tax function once (cheap).
 */
function optimizeSchedule(input: AmtIsoInput): number[] {
  const horizon = input.horizon;
  if (horizon < 1) return [];
  if (horizon === 1) return [input.shares];

  const ctx = buildYearContext(input);
  const granularity = gridGranularity(horizon);
  const chunkShares = input.shares / granularity;
  const bpsByYear = Array.from({ length: horizon }, (_, i) =>
    bargainPerShareForYear(input, i + 1),
  );

  // Objective: minimize the future-valued cash-tax stream (equivalent to
  // maximizing netFinalValue at horizon, since gross sale value is constant
  // across schedules with the same input). At cashReturnRate=0 this is the
  // nominal sum, recovering the v1 optimizer exactly. At rate>0 it correctly
  // penalizes schedules that bunch outflows in early years.
  const fvWeight = (yearIdx: number): number =>
    Math.pow(1 + input.cashReturnRate, Math.max(0, horizon - 1 - yearIdx));

  function scheduleFvCost(schedule: Schedule): number {
    let total = 0;
    for (let i = 0; i < schedule.years.length; i++) {
      total += schedule.years[i].cashTax * fvWeight(i);
    }
    return total;
  }

  // dp[remaining_year_index][remaining_chunks] = { tax, chunksThisYear, creditAfter }
  // We must thread the creditBalance through the DP, but to keep state finite
  // we discretize credit balance too — OR, equivalently, just do a forward DP
  // that tracks (yearIndex, chunksAllocated, creditBalance_quantized) → min remaining tax.
  // Simpler exact approach: enumerate the H-tuple of chunk allocations directly,
  // but prune via a depth-first walk with running totals + branch-and-bound.

  // For horizon ≤ 5 and granularity 100, depth-first enumeration with pruning
  // is fastest and avoids credit-balance discretization. ~10ms in browser.

  // Seed bestFvCost from lump-sum AND even-split so branch-and-bound prunes
  // from the first node. Even-split allocations (shares/horizon) usually
  // don't land on the chunk grid, so seeding it directly guarantees
  // `optimized` is never worse than either of the two comparison plans —
  // a UI invariant the plan-comparison strip relies on.
  const lumpSplit = [input.shares, ...new Array(horizon - 1).fill(0)];
  let bestFvCost = scheduleFvCost(runSchedule('lump_sum', lumpSplit, input));
  let bestSplit = lumpSplit.slice();
  const evenSplit = new Array(horizon).fill(input.shares / horizon);
  const evenFvCost = scheduleFvCost(runSchedule('even_split', evenSplit, input));
  if (evenFvCost < bestFvCost) {
    bestFvCost = evenFvCost;
    bestSplit = evenSplit.slice();
  }

  const currentSplit = new Array(horizon).fill(0);

  function dfs(
    yearIdx: number,
    chunksRemaining: number,
    creditBalance: number,
    fvTaxSoFar: number,
  ): void {
    if (fvTaxSoFar >= bestFvCost) return;

    const bps = bpsByYear[yearIdx];

    if (yearIdx === horizon - 1) {
      const shares = chunksRemaining * chunkShares;
      currentSplit[yearIdx] = shares;
      const yt = computeYearTax(yearIdx + 1, shares, bps, ctx, creditBalance);
      const total = fvTaxSoFar + yt.cashTax * fvWeight(yearIdx);
      if (total < bestFvCost) {
        bestFvCost = total;
        bestSplit = currentSplit.slice();
      }
      return;
    }

    for (let c = 0; c <= chunksRemaining; c++) {
      const shares = c * chunkShares;
      currentSplit[yearIdx] = shares;
      const yt = computeYearTax(yearIdx + 1, shares, bps, ctx, creditBalance);
      const newCredit = creditBalance + yt.amtOwedFederal - yt.creditRecovered;
      dfs(
        yearIdx + 1,
        chunksRemaining - c,
        newCredit,
        fvTaxSoFar + yt.cashTax * fvWeight(yearIdx),
      );
    }
  }

  dfs(0, granularity, input.carryforwardCredit, 0);

  // ---- Refinement to 1-share granularity ----
  // The coarse grid (chunkShares = shares/granularity, e.g. 333 shares for
  // a 20K-share / 4-year scenario at granularity=60) finds the chunk-aligned
  // optimum but can miss the true optimum by up to one chunk on each year if
  // the function's piecewise-linear kinks (AMT phaseout, bracket boundaries)
  // lie between grid points. Hill-climb at 1-share granularity from the
  // chunk-grid winner: try moving 1 share between every year-pair; accept
  // any improvement. Converges to the true 1-share local optimum, which —
  // given the coarse grid already located the correct smooth region — is
  // the global optimum.
  let refined = bestSplit.map((s) => Math.round(s));
  const totalShares = Math.round(input.shares);
  let drift = refined.reduce((a, b) => a + b, 0) - totalShares;
  if (drift !== 0) {
    // Absorb rounding drift in the largest year so total stays exact.
    let argmax = 0;
    for (let i = 1; i < refined.length; i++) if (refined[i] > refined[argmax]) argmax = i;
    refined[argmax] -= drift;
  }
  let refinedCost = scheduleFvCost(runSchedule('optimized', refined, input));
  let improving = true;
  let iterations = 0;
  const MAX_REFINE_ITER = 20_000; // safety cap; convergence is typically <1K
  while (improving && iterations < MAX_REFINE_ITER) {
    improving = false;
    iterations++;
    for (let i = 0; i < horizon; i++) {
      if (refined[i] === 0) continue;
      for (let j = 0; j < horizon; j++) {
        if (i === j) continue;
        const candidate = refined.slice();
        candidate[i] -= 1;
        candidate[j] += 1;
        const candidateCost = scheduleFvCost(runSchedule('optimized', candidate, input));
        if (candidateCost < refinedCost - 1e-9) {
          refined = candidate;
          refinedCost = candidateCost;
          improving = true;
        }
      }
    }
  }
  return refined;
}

// ---------------------------------------------------------------
// Departed-user partial-exercise optimizer
// ---------------------------------------------------------------
//
// For a user who has left the company and is inside the 90-day exercise
// window, the schedule decision collapses to a single dimension: how many
// of N shares to exercise (the rest expire). The trade-off is AMT cost now
// vs. expected after-tax value at a future hold horizon.
//
// Objective (maximize over Q):
//   netValue(Q) = Q × (P_T − K) × (1 − fedLTCG_marginal − stateLTCG_marginal)
//                 − exerciseTax(Q)
//
// where P_T = fmv × (1+g)^holdYears, K = strike, exerciseTax(Q) is the AMT
// delta over baseline regular tax for a lump-Q exercise this year.
//
// Implementation: coarse grid scan over Q (uniform sampling) followed by a
// refinement pass around the best coarse point. Federal LTCG includes NIIT;
// state LTCG honors the per-state preferential rules in state-tax.ts.

const DEPARTED_GRID_STEPS = 50;
const DEPARTED_REFINE_STEPS = 20;

// One-shot context for the optimizer's Q-scan: build YearContext + LTCG
// constants once instead of rebuilding on every grid point (the per-call
// invariants don't depend on Q).
interface DepartedQContext {
  ctx: YearContext;
  baselineRegular: number;        // regularFederal + regularState (Q=0 cashTax)
  bargainPerShareYear1: number;   // lump exercise this year, no compounding
  futureFmvPerShare: number;      // fmv × (1+g_eff)^holdYears
  ordinaryIncome: number;
  filingStatus: FilingStatus;
  stateCode: string;
}

function buildDepartedQContext(input: AmtIsoInput): DepartedQContext {
  const ctx = buildYearContext(input);
  const g = effectiveAnnualGrowth(input);
  const T = Math.max(1, input.horizon);
  return {
    ctx,
    baselineRegular: ctx.regularFederal + ctx.regularState,
    bargainPerShareYear1: bargainPerShareForYear(input, 1),
    futureFmvPerShare: input.fmv * Math.pow(1 + g, T),
    ordinaryIncome: input.ordinaryIncome,
    filingStatus: input.filingStatus,
    stateCode: input.stateCode,
  };
}

function netValueForQuantity(
  Q: number,
  qctx: DepartedQContext,
  strike: number,
): { netValue: number; exerciseTax: number } {
  if (Q <= 0) return { netValue: 0, exerciseTax: 0 };
  const yearTax = computeYearTax(1, Q, qctx.bargainPerShareYear1, qctx.ctx, 0);
  const exerciseTax = yearTax.cashTax - qctx.baselineRegular;
  const grossGain = Q * (qctx.futureFmvPerShare - strike);
  if (grossGain <= 0) return { netValue: -exerciseTax, exerciseTax };
  const fed = computeFederalGainTax({
    ordinaryIncome: qctx.ordinaryIncome,
    gainAmount: grossGain,
    isLongTerm: true,
    filingStatus: qctx.filingStatus,
  });
  const state = computeStateGainTax({
    stateCode: qctx.stateCode,
    ordinaryIncome: qctx.ordinaryIncome,
    gainAmount: grossGain,
    isLongTerm: true,
    filingStatus: qctx.filingStatus,
  });
  return { netValue: grossGain - fed - state - exerciseTax, exerciseTax };
}

export function optimizeDepartedExerciseQuantity(
  input: AmtIsoInput,
): DepartedRecommendation {
  const N = input.shares;
  const qctx = buildDepartedQContext(input);

  const curve: { shares: number; netValue: number; exerciseTax: number }[] = [];
  for (let i = 0; i <= DEPARTED_GRID_STEPS; i++) {
    const Q = (N * i) / DEPARTED_GRID_STEPS;
    const { netValue, exerciseTax } = netValueForQuantity(Q, qctx, input.strike);
    curve.push({ shares: Q, netValue, exerciseTax });
  }

  let bestIdx = 0;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].netValue > curve[bestIdx].netValue) bestIdx = i;
  }
  const lo = curve[Math.max(0, bestIdx - 1)].shares;
  const hi = curve[Math.min(curve.length - 1, bestIdx + 1)].shares;
  let bestQ = curve[bestIdx].shares;
  let bestNet = curve[bestIdx].netValue;
  for (let i = 0; i <= DEPARTED_REFINE_STEPS; i++) {
    const Q = lo + ((hi - lo) * i) / DEPARTED_REFINE_STEPS;
    const { netValue } = netValueForQuantity(Q, qctx, input.strike);
    if (netValue > bestNet) {
      bestNet = netValue;
      bestQ = Q;
    }
  }

  // Round to whole shares and re-evaluate so the surfaced net-value matches
  // the surfaced count exactly.
  const recommendedShares = Math.round(bestQ);
  const atRecommended = netValueForQuantity(recommendedShares, qctx, input.strike);
  const atFull = netValueForQuantity(N, qctx, input.strike);

  // Multi-year schedule for the table: year 1 = lump-Q*, years 2..T = 0
  // exercise (so any AMT credit earned in year 1 can recover against the
  // user's ordinary income headroom in subsequent years).
  const T = Math.max(1, input.horizon);
  const split = [recommendedShares, ...new Array(Math.max(0, T - 1)).fill(0)];
  const recommendedSchedule = runSchedule('optimized', split, { ...input, horizon: T });

  return {
    recommendedShares,
    recommendedExerciseTax: atRecommended.exerciseTax,
    recommendedNetValue: atRecommended.netValue,
    fullExerciseShares: N,
    fullExerciseTax: atFull.exerciseTax,
    fullExerciseNetValue: atFull.netValue,
    holdYears: T,
    futureFmvPerShare: qctx.futureFmvPerShare,
    recommendedSchedule,
    curve,
  };
}

// ---------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------

export function computeAmtIso(input: AmtIsoInput, today: Date = new Date()): AmtIsoResult {
  const timing = computeTimingFlags(input, today);
  const effectiveHorizon = Math.max(1, Math.min(input.horizon, timing.maxHorizon));
  const effective: AmtIsoInput = { ...input, horizon: effectiveHorizon };

  // Crossover always uses year-1 bargain (today's FMV).
  const bargainPerShareYear1 = bargainPerShareForYear(effective, 1);

  const { crossoverBargain, alreadyInAmt } = findCrossoverBargain(effective);
  const crossoverShares =
    bargainPerShareYear1 > 0 ? Math.floor(crossoverBargain / bargainPerShareYear1) : 0;

  // Three plans, all run at effectiveHorizon
  const lumpSplit = [effective.shares, ...new Array(effectiveHorizon - 1).fill(0)];
  const evenSplit = new Array(effectiveHorizon).fill(effective.shares / effectiveHorizon);
  const optimizedSplit = optimizeSchedule(effective);

  // Departed users inside the 90-day window get a partial-exercise
  // recommendation. The exercise schedule is still year-1 lump (no
  // multi-year scheduling possible); input.horizon is reinterpreted as the
  // post-exercise hold horizon for the value calc.
  const departedRecommendation =
    input.hasLeftCompany && !timing.windowClosed
      ? optimizeDepartedExerciseQuantity(input)
      : undefined;

  return {
    crossoverShares,
    crossoverBargain,
    alreadyInAmt,
    schedules: {
      lumpSum: runSchedule('lump_sum', lumpSplit, effective),
      evenSplit: runSchedule('even_split', evenSplit, effective),
      optimized: runSchedule('optimized', optimizedSplit, effective),
    },
    stateHasAmt: hasStateAmt(input.stateCode),
    bargainPerShare: bargainPerShareYear1,
    timing,
    effectiveHorizon,
    departedRecommendation,
  };
}
