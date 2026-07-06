// AlphaLatitude Inc. © 2026
//
// Concentration calculator orchestrator.
// Takes the 8 user inputs and returns every output the page renders.
// Pure function — no I/O, no state. Re-runs synchronously on every input change.

import {
  computeFederalGainTax,
  computeStateGainTax,
  sliceBracketsAcrossDelta,
  getStateBrackets,
} from '@/lib/tax';
import type { FilingStatus } from '@/lib/tax';
import { LTCG_2026, ORDINARY_2026, NIIT_RATE, NIIT_THRESHOLDS } from '@/lib/tax/federal-2026';
import { SECTOR_STATS, type SectorKey } from '@/lib/markets/sector-stats';
import { blackScholesPut, blackScholesCall } from '@/lib/options/black-scholes';
import { RISK_FREE_RATE_1Y } from '@/lib/tax/federal-2026';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type ConcentrationInputs = {
  positionValue: number;
  costBasis: number;
  acquisitionDate: Date;
  sector: SectorKey;
  stateCode: string;
  filingStatus: FilingStatus;
  ordinaryIncome: number;
  totalAssets: number;
  // Two user-set rates:
  //   expectedPositionReturn — the user's view of the concentrated stock's
  //     annual return. Drives the bracket-compounding effect (price grows
  //     while basis stays fixed → bigger gains in later years).
  //   expectedMarketReturn — return on everything else: the rest of the
  //     portfolio AND after-tax proceeds reinvested.
  // Splitting them lets the user model "I'm bullish on this stock vs. the
  // market" or "I want to swap this for diversified holdings." When they're
  // equal, schedule timing only matters when bracket crossings happen.
  expectedPositionReturn: number;
  expectedMarketReturn: number;
  // Multiplicative haircut at the planning horizon on the concentrated
  // position's projected price. Accounts for the fact that single-stock
  // realized growth lags arithmetic-mean growth by σ²/2 per year (volatility
  // drag). Applied to the held position only — diversified reinvestment in
  // expectedMarketReturn already represents a vol-averaged return. Range
  // [0, 0.99]; 0 disables drag. 20% default (matches NSO + AMT-ISO tools).
  // Auto-fills from the chain's ATM IV when a public ticker is set.
  volatilityDrag: number;
  // When set, overrides SECTOR_STATS[sector].annualVol × IV_OVER_RV_MULTIPLIER
  // as σ for the hedging Black-Scholes path. Chain-driven UI passes the
  // chain-implied vol at the 30% OTM put for tenor=1y, so we use the actual
  // market price of protection instead of a sector-typed estimate.
  volatility?: number;
  // User-picked hedge structure from the Protective Put tool, threaded
  // through to overrride the default 30%-OTM / 1-yr long-put pricing
  // in buildCustomPlan. When kind='collar', the year's hedge cost is
  // the net premium (put − call) and a call-exercise event clamps the
  // year's gain at the cap. When absent, calc reverts to defaults.
  hedgeChoice?: {
    kind: 'put' | 'collar';
    protectionLevel: number;
    tenorYears: number;
    upsideCapPct?: number;
  };
};

export type RiskBand = 'Low' | 'Moderate' | 'Concentrated' | 'Highly concentrated' | 'Extreme';

export type LossScenario = {
  drop: number;          // 0.30, 0.50, 0.70
  dollarLoss: number;
  newConcentration: number;
};

export type TaxBreakdownRow = {
  label: string;            // e.g. "Federal LTCG", "NIIT", "California"
  rate: number;             // e.g. 0.15
  amount: number;           // dollars in this slice
  tax: number;              // amount × rate
};

export type YearlySale = {
  year: number;          // 1..5
  saleAmount: number;
  gainAmount: number;
  isLongTerm: boolean;
  federalTax: number;
  stateTax: number;
  totalTax: number;
  breakdown: TaxBreakdownRow[];
  // Exercise sales (from put exercising on drawdown) arrive at year-end of `year`.
  // Wealth tracking now uses per-month cash records, so this flag is informational
  // only — it lets the UI distinguish synthetic exercise events from regular sales.
  isExercise?: boolean;
};

// Two independent flag arrays, one boolean per year (length = HORIZON_YEARS).
// A year can be sell, hedge, both, or neither.
export type CustomActions = {
  sell: boolean[];
  hedge: boolean[];
};

export type CustomPlan = {
  actions: CustomActions;
  yearlySales: YearlySale[]; // years where sell=true; may be fewer than HORIZON_YEARS
  totalSale: number;
  totalTax: number;
  totalHedgeCost: number;
  wealthByYear: number[];      // length = HORIZON_YEARS + 1
  endOfHorizonWealth: number;
  positionStillHeld: number;   // dollar value at horizon of any still-held position
  taxBreakdown: TaxBreakdownRow[];
};

export type SchedulePlan = {
  planKey: 'lump_sum' | 'two_year' | 'three_year';
  planLabel: string;
  yearlySales: YearlySale[];
  totalSale: number;            // sum of nominal sale dollars across years
  totalTax: number;
  endOfHorizonWealth: number;   // total after-tax wealth at end of comparison horizon
  savingsVsLumpSum: number;     // positive means this plan is cheaper than lump-sum (raw tax)
  wealthVsLumpSum: number;      // positive means this plan ends with more wealth than lump-sum
  year1IsShortTerm: boolean;
  // Sum across all yearlySales: same-rate slices merged so a 3-year plan
  // shows e.g. one row per (federal-LTCG-15%, federal-LTCG-20%, NIIT,
  // CA-9.3%, CA-13.3%, …).
  taxBreakdown: TaxBreakdownRow[];
  // Total wealth at the END of each year, t = 0..HORIZON_YEARS. 6 points.
  // Used to plot the wealth-over-time chart.
  wealthByYear: number[];
};

export type WaitForLtInsight = {
  longTermDate: Date;
  daysAway: number;
  immediateLumpSumTax: number;
  delayedLumpSumTax: number;
  savings: number;
};

export type ConcentrationOutputs = {
  concentration: number;           // 0..1
  riskBand: RiskBand;
  isLongTermToday: boolean;
  longTermDate: Date;
  daysUntilLongTerm: number;       // 0 if already long-term
  lossExposure: LossScenario[];
  waitForLtInsight: WaitForLtInsight | null;
  schedule: SchedulePlan[];
  hedging: {
    // Which structure was priced: 'put' (default) or 'collar', when the caller
    // threads a hedgeChoice with kind: 'collar' and an upsideCapPct.
    kind: 'put' | 'collar';
    // Floor as a fraction below spot (0.30 default = a 30%-OTM put).
    protectionLevel: number;
    tenorYears: number;
    strike: number;              // long put strike in dollars
    putPrice: number;            // gross long-put premium in dollars
    // Collar short-call leg; present only when kind === 'collar'.
    callStrike?: number;
    callPrice?: number;
    // Net premium paid: putPrice for a put; max(0, putPrice − callPrice) for a collar.
    netPremium: number;
    sigma: number;
    riskFreeRate: number;
  };
  sectorContextLine: string;
  advisorBenchmarkLine: string;
};

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

// 0% = sell the entire concentrated position. The plans differ only in
// timing (lump-sum vs. spread), and the user sees the full upper-bound
// cost of going to a fully diversified portfolio.
const TARGET_CONCENTRATION = 0.0;
const LOSS_SCENARIOS = [0.30, 0.50, 0.70];
const PUT_STRIKE_RATIO = 0.70;        // 30%-OTM put
const HEDGE_TENOR_YEARS = 1;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// RV → IV adjustment for the Black-Scholes σ input.
//
// We have realized volatility (RV) per sector from historical price data.
// Real market option prices reflect IMPLIED volatility (IV), which is
// systematically higher than RV because (a) sellers demand a vol risk
// premium, (b) OTM puts trade at a "skew" — IV at lower strikes is higher
// than ATM, and (c) markets price in jump risk that BS's diffusion can't.
//
// Single-name OTM puts (our 70% strike) typically run ~15–25% higher IV
// than realized ATM vol. We apply a flat 1.20× multiplier to bring our
// estimate closer to market, while staying conservative for liquid names.
// Validate against a sample of live option chains during periodic refresh.
export const IV_OVER_RV_MULTIPLIER = 1.20;

// Comparison horizon: wealth in this many years. All plans are evaluated
// at the same point in time so the comparison is apples-to-apples.
// Matches the longest schedule plan (3-year), so the chart ends right
// when all plans complete.
export const HORIZON_YEARS = 3;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

// Translate the user's arithmetic-mean expectedPositionReturn into the
// effective annual growth rate the median realized path follows after
// volatility drag. Same closed-form as NSO + AMT-ISO:
//   effective = r − (−log(1 − drag)) / T
// where `drag` is the multiplicative haircut at the planning horizon T.
// `drag = 0` (or NaN) disables the adjustment entirely.
//
// Applied only to the concentrated position's projection. The reinvested
// market basket (expectedMarketReturn) already represents a vol-averaged
// return and is left unmodified.
export function effectiveAnnualPositionGrowth(inputs: ConcentrationInputs): number {
  const drag = inputs.volatilityDrag;
  if (!Number.isFinite(drag) || drag <= 0) return inputs.expectedPositionReturn;
  const safeDrag = Math.min(0.99, Math.max(0, drag));
  return inputs.expectedPositionReturn - -Math.log(1 - safeDrag) / HORIZON_YEARS;
}

function bandFor(concentration: number): RiskBand {
  if (concentration < 0.10) return 'Low';
  if (concentration < 0.20) return 'Moderate';
  if (concentration < 0.40) return 'Concentrated';
  if (concentration < 0.70) return 'Highly concentrated';
  return 'Extreme';
}

function gainFraction(positionValue: number, costBasis: number): number {
  if (positionValue <= 0) return 0;
  return Math.max(0, (positionValue - costBasis) / positionValue);
}

function sellAmountToTarget(position: number, total: number, target: number): number {
  // Sell X such that (position - X) / total = target
  // → X = position - target * total
  // Floor at 0 (already at or below target).
  return Math.max(0, position - target * total);
}

function computeTaxForSale(args: {
  saleAmount: number;
  gainFrac: number;
  isLongTerm: boolean;
  ordinaryIncome: number;
  filingStatus: FilingStatus;
  stateCode: string;
}): { federalTax: number; stateTax: number; totalTax: number; gainAmount: number } {
  const gainAmount = args.saleAmount * args.gainFrac;
  const federalTax = computeFederalGainTax({
    ordinaryIncome: args.ordinaryIncome,
    gainAmount,
    isLongTerm: args.isLongTerm,
    filingStatus: args.filingStatus,
  });
  const stateTax = computeStateGainTax({
    stateCode: args.stateCode,
    ordinaryIncome: args.ordinaryIncome,
    gainAmount,
    isLongTerm: args.isLongTerm,
    filingStatus: args.filingStatus,
  });
  return {
    gainAmount,
    federalTax,
    stateTax,
    totalTax: federalTax + stateTax,
  };
}

// Per-sale breakdown rows (federal LTCG slices, NIIT, state slices).
function breakdownForSale(args: {
  gainAmount: number;
  isLongTerm: boolean;
  ordinaryIncome: number;
  filingStatus: FilingStatus;
  stateCode: string;
}): TaxBreakdownRow[] {
  const { gainAmount, isLongTerm, ordinaryIncome, filingStatus, stateCode } = args;
  if (gainAmount <= 0) return [];
  const rows: TaxBreakdownRow[] = [];

  // Federal — LTCG slices for long-term, ordinary marginal slices for short-term.
  const federalBrackets = isLongTerm ? LTCG_2026[filingStatus] : ORDINARY_2026[filingStatus];
  const federalLabel = isLongTerm ? 'Federal LTCG' : 'Federal income';
  const federalSlices = sliceBracketsAcrossDelta(ordinaryIncome, gainAmount, federalBrackets);
  for (const s of federalSlices) {
    if (s.tax > 0) rows.push({ label: federalLabel, rate: s.rate, amount: s.amount, tax: s.tax });
  }

  // NIIT — single bucket: 3.8% on min(investment income, AGI excess).
  const agi = ordinaryIncome + gainAmount;
  const niitThreshold = NIIT_THRESHOLDS[filingStatus];
  if (agi > niitThreshold) {
    const taxable = Math.min(gainAmount, agi - niitThreshold);
    if (taxable > 0) {
      rows.push({ label: 'NIIT', rate: NIIT_RATE, amount: taxable, tax: taxable * NIIT_RATE });
    }
  }

  // State — same slicing approach as federal (most states tax LTCG as ordinary).
  // WA is a flat-rate special case.
  if (stateCode === 'WA' && isLongTerm) {
    const taxable = Math.max(0, gainAmount - 270_000);
    if (taxable > 0) {
      rows.push({ label: 'WA LTCG (above $270K)', rate: 0.07, amount: taxable, tax: taxable * 0.07 });
    }
  } else {
    const stateBrackets = getStateBrackets(stateCode, filingStatus);
    if (stateBrackets) {
      const slices = sliceBracketsAcrossDelta(ordinaryIncome, gainAmount, stateBrackets);
      for (const s of slices) {
        if (s.tax > 0) rows.push({ label: stateCode, rate: s.rate, amount: s.amount, tax: s.tax });
      }
    }
  }

  return rows;
}

// Aggregate per-year breakdowns into one set of rows: same (label, rate)
// merge so a multi-year plan reads as a single rolled-up table.
function aggregateBreakdowns(rowsList: TaxBreakdownRow[][]): TaxBreakdownRow[] {
  const map = new Map<string, TaxBreakdownRow>();
  for (const rows of rowsList) {
    for (const r of rows) {
      const key = `${r.label}::${r.rate}`;
      const existing = map.get(key);
      if (existing) {
        existing.amount += r.amount;
        existing.tax += r.tax;
      } else {
        map.set(key, { ...r });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    // Federal first, NIIT next, then state.
    const order = (label: string) =>
      label.startsWith('Federal') ? 0 : label === 'NIIT' ? 1 : 2;
    const oa = order(a.label);
    const ob = order(b.label);
    if (oa !== ob) return oa - ob;
    return a.rate - b.rate;
  });
}

// ---------------------------------------------------------------
// Schedule builder
// ---------------------------------------------------------------

// One sale entry per month, tracked for accurate cash compounding in the
// wealth chart. The full plan has 12 × numYears entries; tax is computed
// once per calendar year on the year's aggregate gain (because that's how
// real estimated taxes are filed) and prorated back across that year's
// months by sale-dollar weight.
type MonthSale = { saleTimeYears: number; saleAmount: number; afterTax: number };

function buildPlan(args: {
  planKey: SchedulePlan['planKey'];
  planLabel: string;
  numYears: number;
  sellFractionTotal: number;       // fraction of TODAY's position to sell across the plan
  inputs: ConcentrationInputs;
  longTermDate: Date;
  today: Date;
}): SchedulePlan {
  const { planKey, planLabel, numYears, sellFractionTotal, inputs, longTermDate, today } = args;
  const rPos = effectiveAnnualPositionGrowth(inputs);
  const rMkt = inputs.expectedMarketReturn;
  const totalMonths = 12 * numYears;
  const sellFractionPerMonth = sellFractionTotal / totalMonths;
  const basisPerYear = (sellFractionTotal / numYears) * inputs.costBasis;

  // Generate per-month sales (k = 1..totalMonths, sale at end of month k → t = k/12).
  const monthSales: MonthSale[] = [];
  for (let k = 1; k <= totalMonths; k++) {
    const tYears = k / 12;
    const saleAmount = sellFractionPerMonth * inputs.positionValue * Math.pow(1 + rPos, tYears);
    monthSales.push({ saleTimeYears: tYears, saleAmount, afterTax: 0 });
  }

  const yearlySales: YearlySale[] = [];
  let totalSaleNominal = 0;
  let totalTax = 0;
  let year1IsShortTerm = false;

  // Aggregate per calendar year: tax computed once on year-aggregate gain,
  // then prorated back to each month for compounding.
  for (let y = 1; y <= numYears; y++) {
    // Holding status determined at year-START: if the year begins before the
    // long-term crossing, treat the entire year as short-term (conservative —
    // overstates tax when crossing happens mid-year). Avoids the complexity
    // of splitting a single year into ST + LT slices.
    const yearStartDate = new Date(today.getTime() + (y - 1) * ONE_YEAR_MS);
    const isLongTerm = yearStartDate.getTime() >= longTermDate.getTime();

    let yearSale = 0;
    const yearMonthIndices: number[] = [];
    for (let j = 0; j < 12; j++) {
      const idx = 12 * (y - 1) + j;
      yearSale += monthSales[idx].saleAmount;
      yearMonthIndices.push(idx);
    }
    const gainAmount = Math.max(0, yearSale - basisPerYear);

    const fed = computeFederalGainTax({
      ordinaryIncome: inputs.ordinaryIncome,
      gainAmount,
      isLongTerm,
      filingStatus: inputs.filingStatus,
    });
    const state = computeStateGainTax({
      stateCode: inputs.stateCode,
      ordinaryIncome: inputs.ordinaryIncome,
      gainAmount,
      isLongTerm,
      filingStatus: inputs.filingStatus,
    });
    const taxY = fed + state;
    const breakdown = breakdownForSale({
      gainAmount,
      isLongTerm,
      ordinaryIncome: inputs.ordinaryIncome,
      filingStatus: inputs.filingStatus,
      stateCode: inputs.stateCode,
    });

    // Prorate the year's tax across its months by sale-dollar weight.
    if (yearSale > 0) {
      for (const idx of yearMonthIndices) {
        const ms = monthSales[idx];
        const weight = ms.saleAmount / yearSale;
        ms.afterTax = ms.saleAmount - taxY * weight;
      }
    }

    yearlySales.push({
      year: y,
      saleAmount: yearSale,
      gainAmount,
      isLongTerm,
      federalTax: fed,
      stateTax: state,
      totalTax: taxY,
      breakdown,
    });

    totalSaleNominal += yearSale;
    totalTax += taxY;
    if (y === 1 && !isLongTerm) year1IsShortTerm = true;
  }

  // End-of-horizon wealth: position remainder grows at rPos, other assets at
  // rMkt, every month's after-tax cash compounds at rMkt from sale time.
  const positionAtH =
    Math.max(0, 1 - sellFractionTotal) * inputs.positionValue * Math.pow(1 + rPos, HORIZON_YEARS);
  const otherAssetsAtH =
    Math.max(0, inputs.totalAssets - inputs.positionValue) * Math.pow(1 + rMkt, HORIZON_YEARS);
  let proceedsAtH = 0;
  for (const ms of monthSales) {
    proceedsAtH += ms.afterTax * Math.pow(1 + rMkt, HORIZON_YEARS - ms.saleTimeYears);
  }
  const endOfHorizonWealth = positionAtH + otherAssetsAtH + proceedsAtH;

  // Wealth at end of each year y in [0, H]. Y=0 always equals T0 because the
  // first sale lands at end of month 1 (t = 1/12, > 0).
  const wealthByYear: number[] = [];
  for (let y = 0; y <= HORIZON_YEARS; y++) {
    const fractionSoldByY =
      (sellFractionTotal / numYears) * Math.min(y, numYears);
    const positionY =
      Math.max(0, 1 - fractionSoldByY) * inputs.positionValue * Math.pow(1 + rPos, y);
    const otherY =
      Math.max(0, inputs.totalAssets - inputs.positionValue) * Math.pow(1 + rMkt, y);
    let proceedsY = 0;
    for (const ms of monthSales) {
      if (ms.saleTimeYears > y) continue;
      proceedsY += ms.afterTax * Math.pow(1 + rMkt, y - ms.saleTimeYears);
    }
    wealthByYear.push(positionY + otherY + proceedsY);
  }

  return {
    planKey,
    planLabel,
    yearlySales,
    totalSale: totalSaleNominal,
    totalTax,
    endOfHorizonWealth,
    savingsVsLumpSum: 0, // filled in by caller after fastest plan is known
    wealthVsLumpSum: 0,  // ditto
    year1IsShortTerm,
    taxBreakdown: aggregateBreakdowns(yearlySales.map((s) => s.breakdown)),
    wealthByYear,
  };
}

// ---------------------------------------------------------------
// Shared hedge pricing
// ---------------------------------------------------------------
// Prices the hedge leg used by both the static hedging line (calculate) and
// the per-year custom plan (buildCustomPlan). Default: a 1-year 30%-OTM put.
// When the caller threads a hedgeChoice (kind / protectionLevel / tenorYears,
// plus upsideCapPct for collars — set via the Protective Put tool's "Apply to
// plan" handoff), that structure is priced instead. Extracted so the two
// concentration paths can never diverge. σ is passed in already resolved
// (chain-implied if provided, else sector RV × IV adjustment).

type HedgePricing = {
  kind: 'put' | 'collar';
  protectionLevel: number;     // floor as a fraction below spot (0.30 = 30%-OTM)
  tenorYears: number;
  strike: number;              // long put strike in dollars
  putPrice: number;            // gross long-put premium in dollars
  callStrike?: number;         // collar short-call strike; present only for a collar
  callPrice?: number;          // collar short-call premium; present only for a collar
  netPremium: number;          // putPrice for a put; max(0, putPrice − callPrice) for a collar
};

function priceHedge(
  spot: number,
  sigma: number,
  hedgeChoice: ConcentrationInputs['hedgeChoice'],
  riskFreeRate: number,
): HedgePricing {
  const kind: 'put' | 'collar' = hedgeChoice?.kind ?? 'put';
  const protectionLevel = hedgeChoice ? hedgeChoice.protectionLevel : 1 - PUT_STRIKE_RATIO;
  const tenorYears = hedgeChoice ? hedgeChoice.tenorYears : HEDGE_TENOR_YEARS;
  const strike = spot * (1 - protectionLevel);
  const putPrice = blackScholesPut({
    spot,
    strike,
    riskFreeRate,
    volatility: sigma,
    timeYears: tenorYears,
  });
  let callStrike: number | undefined;
  let callPrice: number | undefined;
  let netPremium = putPrice;
  // For a collar, sell a call at +upsideCapPct above spot and net the premium.
  // Clamped at 0 — a credit collar's residual cash isn't routed back into the
  // wealth path, so display as free rather than negative-cost.
  if (kind === 'collar' && typeof hedgeChoice?.upsideCapPct === 'number') {
    callStrike = spot * (1 + hedgeChoice.upsideCapPct);
    callPrice = blackScholesCall({
      spot,
      strike: callStrike,
      riskFreeRate,
      volatility: sigma,
      timeYears: tenorYears,
    });
    netPremium = Math.max(0, putPrice - callPrice);
  }
  return { kind, protectionLevel, tenorYears, strike, putPrice, callStrike, callPrice, netPremium };
}

// ---------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------

export function calculate(inputs: ConcentrationInputs, now?: Date): ConcentrationOutputs {
  const today = now ?? new Date();

  const concentration = inputs.totalAssets > 0
    ? inputs.positionValue / inputs.totalAssets
    : 0;

  // Holding status
  const longTermDate = new Date(inputs.acquisitionDate.getTime() + ONE_YEAR_MS);
  const isLongTermToday = today.getTime() >= longTermDate.getTime();
  const daysUntilLongTerm = isLongTermToday
    ? 0
    : Math.ceil((longTermDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

  // Loss exposure
  const lossExposure: LossScenario[] = LOSS_SCENARIOS.map((drop) => {
    const dollarLoss = inputs.positionValue * drop;
    const newPosition = inputs.positionValue - dollarLoss;
    const newTotal = inputs.totalAssets - dollarLoss;
    const newConc = newTotal > 0 ? newPosition / newTotal : 0;
    return { drop, dollarLoss, newConcentration: newConc };
  });

  // De-concentration schedule
  // Sell fraction sized at TODAY's prices to bring concentration to target.
  // Multi-year plans sell the same fraction split across years; the dollar
  // amount of each year's sale grows because the price compounds.
  const totalSaleToday = sellAmountToTarget(inputs.positionValue, inputs.totalAssets, TARGET_CONCENTRATION);
  const sellFractionTotal =
    inputs.positionValue > 0 ? totalSaleToday / inputs.positionValue : 0;

  const plans: SchedulePlan[] =
    sellFractionTotal <= 0
      ? [] // already at or below target — no schedule
      : [
          buildPlan({ planKey: 'lump_sum',   planLabel: 'Sell over 1 year',  numYears: 1, sellFractionTotal, inputs, longTermDate, today }),
          buildPlan({ planKey: 'two_year',   planLabel: 'Sell over 2 years', numYears: 2, sellFractionTotal, inputs, longTermDate, today }),
          buildPlan({ planKey: 'three_year', planLabel: 'Sell over 3 years', numYears: 3, sellFractionTotal, inputs, longTermDate, today }),
        ];

  // Hypothetical lump-sum baseline — sell the entire position today (t=0),
  // pay tax immediately, then compound (totalAssets − tax) at the market rate
  // for the full horizon. None of the displayed plans actually do this; it's
  // a benchmark so each plan can show its delta against the "rip the bandaid"
  // option.
  let lumpSumTax = 0;
  let lumpSumWealth = inputs.totalAssets * Math.pow(1 + inputs.expectedMarketReturn, HORIZON_YEARS);
  if (plans.length > 0) {
    const gainAmount = Math.max(0, inputs.positionValue - inputs.costBasis);
    const fed = computeFederalGainTax({
      ordinaryIncome: inputs.ordinaryIncome,
      gainAmount,
      isLongTerm: isLongTermToday,
      filingStatus: inputs.filingStatus,
    });
    const state = computeStateGainTax({
      stateCode: inputs.stateCode,
      ordinaryIncome: inputs.ordinaryIncome,
      gainAmount,
      isLongTerm: isLongTermToday,
      filingStatus: inputs.filingStatus,
    });
    lumpSumTax = fed + state;
    lumpSumWealth =
      (inputs.totalAssets - lumpSumTax) * Math.pow(1 + inputs.expectedMarketReturn, HORIZON_YEARS);

    for (const p of plans) {
      p.savingsVsLumpSum = lumpSumTax - p.totalTax;
      p.wealthVsLumpSum = p.endOfHorizonWealth - lumpSumWealth;
    }
  }

  // Wait-for-long-term insight
  let waitForLtInsight: WaitForLtInsight | null = null;
  if (!isLongTermToday && totalSaleToday > 0) {
    const gainFrac = gainFraction(inputs.positionValue, inputs.costBasis);

    const immediateTax = computeTaxForSale({
      saleAmount: totalSaleToday,
      gainFrac,
      isLongTerm: false,
      ordinaryIncome: inputs.ordinaryIncome,
      filingStatus: inputs.filingStatus,
      stateCode: inputs.stateCode,
    }).totalTax;

    const delayedTax = computeTaxForSale({
      saleAmount: totalSaleToday,
      gainFrac,
      isLongTerm: true,
      ordinaryIncome: inputs.ordinaryIncome,
      filingStatus: inputs.filingStatus,
      stateCode: inputs.stateCode,
    }).totalTax;

    waitForLtInsight = {
      longTermDate,
      daysAway: daysUntilLongTerm,
      immediateLumpSumTax: immediateTax,
      delayedLumpSumTax: delayedTax,
      savings: Math.max(0, immediateTax - delayedTax),
    };
  }

  // Hedging cost via Black-Scholes on the current position value. Chain-supplied
  // implied vol is used directly (already implied); otherwise sector RV ×
  // multiplier keeps the legacy / sector-only flow realistic. Structure (put or
  // collar, floor, tenor) follows the threaded hedgeChoice — see priceHedge.
  const sigma = inputs.volatility ?? SECTOR_STATS[inputs.sector].annualVol * IV_OVER_RV_MULTIPLIER;
  const hedge = priceHedge(inputs.positionValue, sigma, inputs.hedgeChoice, RISK_FREE_RATE_1Y);

  const sectorContextLine = SECTOR_STATS[inputs.sector].contextLine;
  const concentrationPct = Math.round(concentration * 100);
  const advisorBenchmarkLine =
    `Most fee-only advisors target ≤10% in any single name. You're at ${concentrationPct}%.`;

  return {
    concentration,
    riskBand: bandFor(concentration),
    isLongTermToday,
    longTermDate,
    daysUntilLongTerm,
    lossExposure,
    waitForLtInsight,
    schedule: plans,
    hedging: {
      kind: hedge.kind,
      protectionLevel: hedge.protectionLevel,
      tenorYears: hedge.tenorYears,
      strike: hedge.strike,
      putPrice: hedge.putPrice,
      callStrike: hedge.callStrike,
      callPrice: hedge.callPrice,
      netPremium: hedge.netPremium,
      sigma,
      riskFreeRate: RISK_FREE_RATE_1Y,
    },
    sectorContextLine,
    advisorBenchmarkLine,
  };
}

// ---------------------------------------------------------------
// Custom plan: per-year sell/hedge toggles
// ---------------------------------------------------------------
// User flips two independent toggles per year:
//   sell  — spread one slice (1/numSellYears of original) across this year as
//           12 monthly sales
//   hedge — buy a 1-yr put at year start covering the position then held
// Slice size REBALANCES based on the count of sell-years: if 2 of 3 years
// are sell, each year sells 1/2 of the original position. 0 sell-years = no
// sales; the position rides through. At horizon, any unsold position stays
// in the user's portfolio at market value (no tax on unrealized gain).

export function buildCustomPlan(
  inputs: ConcentrationInputs,
  actions: CustomActions,
  now?: Date,
): CustomPlan {
  const today = now ?? new Date();
  const rPos = effectiveAnnualPositionGrowth(inputs);
  const rMkt = inputs.expectedMarketReturn;
  // Same precedence as the static hedging line: chain-implied σ if provided,
  // else sector RV × IV adjustment.
  const sigma = inputs.volatility ?? SECTOR_STATS[inputs.sector].annualVol * IV_OVER_RV_MULTIPLIER;
  const longTermDate = new Date(inputs.acquisitionDate.getTime() + ONE_YEAR_MS);
  const N = actions.sell.length;

  const numSellYears = actions.sell.filter(Boolean).length;
  const sellFractionPerSellYear = numSellYears > 0 ? 1 / numSellYears : 0;
  const sellFractionPerMonth = sellFractionPerSellYear / 12;
  const basisPerSellYear = sellFractionPerSellYear * inputs.costBasis;

  // Per-month cash records for accurate compounding in the wealth chart.
  type MS = { saleTimeYears: number; saleAmount: number; afterTax: number };
  const monthSales: MS[] = [];

  const yearlySales: YearlySale[] = [];
  const hedgeCosts: number[] = [];
  // Put-exercise event: when hedge[y]=true AND rPos < −30%, the put exercises
  // at end of year y. Position residual converts to cash at strike (long-term
  // cap-gain tax), and the entire position is gone from then on.
  let exerciseAtYear: number | null = null;
  let totalTax = 0;
  let totalSaleNominal = 0;
  let totalHedgeCost = 0;
  let cumSellFraction = 0;

  for (let y = 1; y <= N; y++) {
    const willSell = actions.sell[y - 1];
    const willHedge = actions.hedge[y - 1];

    // After an exercise, position is gone. Subsequent sell/hedge actions no-op.
    if (exerciseAtYear !== null) {
      hedgeCosts.push(0);
      continue;
    }

    // Position fraction (of original) at year-y start, before this year's sells.
    const positionFractionAtYearStart = Math.max(0, 1 - cumSellFraction);
    const positionAtYearStart =
      positionFractionAtYearStart * inputs.positionValue * Math.pow(1 + rPos, y - 1);

    // Year-y monthly sells (only if willSell). Each month k=1..12 of year y
    // sells sellFractionPerMonth of the original position at the year-y month-k
    // price. Tax is computed once on year-aggregate gain, prorated to months.
    let yearSale = 0;
    const yearMonthIndices: number[] = [];
    if (willSell && sellFractionPerMonth > 0) {
      for (let j = 1; j <= 12; j++) {
        const tYears = (y - 1) + j / 12;
        const monthSale =
          sellFractionPerMonth * inputs.positionValue * Math.pow(1 + rPos, tYears);
        yearMonthIndices.push(monthSales.length);
        monthSales.push({ saleTimeYears: tYears, saleAmount: monthSale, afterTax: 0 });
        yearSale += monthSale;
      }

      const yearStartDate = new Date(today.getTime() + (y - 1) * ONE_YEAR_MS);
      const isLongTerm = yearStartDate.getTime() >= longTermDate.getTime();
      const gainAmount = Math.max(0, yearSale - basisPerSellYear);

      const fed = computeFederalGainTax({
        ordinaryIncome: inputs.ordinaryIncome,
        gainAmount,
        isLongTerm,
        filingStatus: inputs.filingStatus,
      });
      const state = computeStateGainTax({
        stateCode: inputs.stateCode,
        ordinaryIncome: inputs.ordinaryIncome,
        gainAmount,
        isLongTerm,
        filingStatus: inputs.filingStatus,
      });
      const taxY = fed + state;
      const breakdown = breakdownForSale({
        gainAmount,
        isLongTerm,
        ordinaryIncome: inputs.ordinaryIncome,
        filingStatus: inputs.filingStatus,
        stateCode: inputs.stateCode,
      });

      // Prorate tax across months by sale-dollar weight.
      if (yearSale > 0) {
        for (const idx of yearMonthIndices) {
          const ms = monthSales[idx];
          const weight = ms.saleAmount / yearSale;
          ms.afterTax = ms.saleAmount - taxY * weight;
        }
      }

      yearlySales.push({
        year: y,
        saleAmount: yearSale,
        gainAmount,
        isLongTerm,
        federalTax: fed,
        stateTax: state,
        totalTax: taxY,
        breakdown,
      });

      totalSaleNominal += yearSale;
      totalTax += taxY;
      cumSellFraction += sellFractionPerSellYear;
    }

    // Hedge: put-or-collar bought at year start (t = y−1) on year-start
    // position. Cost paid out of other assets; lost compounding tracked
    // separately below. When the user threads a hedgeChoice through
    // ConcentrationInputs (set via the Protective Put tool's
    // "Apply to plan" handoff), the floor / tenor / kind override the
    // defaults. Otherwise: long 30%-OTM put for 1 year.
    if (willHedge && positionAtYearStart > 0) {
      const pick = inputs.hedgeChoice;
      // Same put-or-collar pricing as the static hedging line, on the
      // year-start position value (see priceHedge).
      const hedge = priceHedge(positionAtYearStart, sigma, pick, RISK_FREE_RATE_1Y);
      const strikeRatio = 1 - hedge.protectionLevel; // 0.70 default → 30%-OTM
      const strike = hedge.strike;
      const hedgePrice = hedge.netPremium;
      const capStrike = hedge.callStrike;
      hedgeCosts.push(hedgePrice);
      totalHedgeCost += hedgePrice;

      // Put-exercise check: rPos below the floor triggers the long-put
      // payoff. Residual position (after the year's monthly sells)
      // converts to cash at the year-start put strike. Always
      // long-term (y ≥ 1 by construction).
      if (1 + rPos < strikeRatio) {
        const positionFractionAtYearEnd = Math.max(0, 1 - cumSellFraction);
        const exerciseProceeds =
          positionFractionAtYearStart > 0
            ? strike * (positionFractionAtYearEnd / positionFractionAtYearStart)
            : 0;
        const basisAllocated = positionFractionAtYearEnd * inputs.costBasis;
        const exerciseGain = Math.max(0, exerciseProceeds - basisAllocated);

        const fed = computeFederalGainTax({
          ordinaryIncome: inputs.ordinaryIncome,
          gainAmount: exerciseGain,
          isLongTerm: true,
          filingStatus: inputs.filingStatus,
        });
        const state = computeStateGainTax({
          stateCode: inputs.stateCode,
          ordinaryIncome: inputs.ordinaryIncome,
          gainAmount: exerciseGain,
          isLongTerm: true,
          filingStatus: inputs.filingStatus,
        });
        const exerciseTax = fed + state;
        const breakdown = breakdownForSale({
          gainAmount: exerciseGain,
          isLongTerm: true,
          ordinaryIncome: inputs.ordinaryIncome,
          filingStatus: inputs.filingStatus,
          stateCode: inputs.stateCode,
        });

        // Exercise cash arrives at end of year y (t = y).
        monthSales.push({
          saleTimeYears: y,
          saleAmount: exerciseProceeds,
          afterTax: exerciseProceeds - exerciseTax,
        });
        yearlySales.push({
          year: y,
          saleAmount: exerciseProceeds,
          gainAmount: exerciseGain,
          isLongTerm: true,
          federalTax: fed,
          stateTax: state,
          totalTax: exerciseTax,
          breakdown,
          isExercise: true,
        });

        totalSaleNominal += exerciseProceeds;
        totalTax += exerciseTax;
        cumSellFraction = 1;
        exerciseAtYear = y;
      } else if (
        capStrike != null &&
        pick?.kind === 'collar' &&
        typeof pick.upsideCapPct === 'number' &&
        1 + rPos > 1 + pick.upsideCapPct
      ) {
        // Call-exercise (collar only): when rPos lands above the cap,
        // the short call is called and the residual position converts
        // to cash at the cap strike. Symmetric mechanics to the put
        // case; long-term gain treatment.
        const positionFractionAtYearEnd = Math.max(0, 1 - cumSellFraction);
        const exerciseProceeds =
          positionFractionAtYearStart > 0
            ? capStrike * (positionFractionAtYearEnd / positionFractionAtYearStart)
            : 0;
        const basisAllocated = positionFractionAtYearEnd * inputs.costBasis;
        const exerciseGain = Math.max(0, exerciseProceeds - basisAllocated);

        const fed = computeFederalGainTax({
          ordinaryIncome: inputs.ordinaryIncome,
          gainAmount: exerciseGain,
          isLongTerm: true,
          filingStatus: inputs.filingStatus,
        });
        const state = computeStateGainTax({
          stateCode: inputs.stateCode,
          ordinaryIncome: inputs.ordinaryIncome,
          gainAmount: exerciseGain,
          isLongTerm: true,
          filingStatus: inputs.filingStatus,
        });
        const exerciseTax = fed + state;
        const breakdown = breakdownForSale({
          gainAmount: exerciseGain,
          isLongTerm: true,
          ordinaryIncome: inputs.ordinaryIncome,
          filingStatus: inputs.filingStatus,
          stateCode: inputs.stateCode,
        });

        monthSales.push({
          saleTimeYears: y,
          saleAmount: exerciseProceeds,
          afterTax: exerciseProceeds - exerciseTax,
        });
        yearlySales.push({
          year: y,
          saleAmount: exerciseProceeds,
          gainAmount: exerciseGain,
          isLongTerm: true,
          federalTax: fed,
          stateTax: state,
          totalTax: exerciseTax,
          breakdown,
          isExercise: true,
        });

        totalSaleNominal += exerciseProceeds;
        totalTax += exerciseTax;
        cumSellFraction = 1;
        exerciseAtYear = y;
      }
    } else {
      hedgeCosts.push(0);
    }
  }

  // Wealth at end of each year y in [0, N].
  const wealthByYear: number[] = [];
  for (let y = 0; y <= N; y++) {
    let soldByY = 0;
    for (let s = 1; s <= Math.min(N, y); s++) {
      if (actions.sell[s - 1]) soldByY += sellFractionPerSellYear;
    }

    const positionAtY =
      exerciseAtYear !== null && y >= exerciseAtYear
        ? 0
        : Math.max(0, 1 - soldByY) * inputs.positionValue * Math.pow(1 + rPos, y);
    const otherAtY =
      Math.max(0, inputs.totalAssets - inputs.positionValue) * Math.pow(1 + rMkt, y);

    let proceedsAtY = 0;
    for (const ms of monthSales) {
      if (ms.saleTimeYears > y) continue;
      proceedsAtY += ms.afterTax * Math.pow(1 + rMkt, y - ms.saleTimeYears);
    }

    // Hedge cost paid at year start (t = h−1) — lost compounding at rMkt.
    let hedgePenaltyAtY = 0;
    for (let h = 1; h <= Math.min(N, y); h++) {
      const cost = hedgeCosts[h - 1];
      if (cost <= 0) continue;
      const payTime = h - 1;
      hedgePenaltyAtY += cost * Math.pow(1 + rMkt, y - payTime);
    }

    wealthByYear.push(positionAtY + otherAtY + proceedsAtY - hedgePenaltyAtY);
  }

  const positionStillHeld =
    exerciseAtYear !== null
      ? 0
      : Math.max(0, 1 - cumSellFraction) * inputs.positionValue * Math.pow(1 + rPos, N);

  return {
    actions,
    yearlySales,
    totalSale: totalSaleNominal,
    totalTax,
    totalHedgeCost,
    wealthByYear,
    endOfHorizonWealth: wealthByYear[wealthByYear.length - 1],
    positionStillHeld,
    taxBreakdown: aggregateBreakdowns(yearlySales.map((s) => s.breakdown)),
  };
}
