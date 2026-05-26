// AlphaLatitude Inc. © 2026
//
// Protective Put + Collar calculator: orchestrates Black-Scholes pricing,
// payoff curves, and holding-period tax-note branching for /tools/protective-put.
//
// All math is pure. No I/O. Tests in protectivePut.test.ts.

import {
  blackScholesCall,
  blackScholesPut,
  probAboveStrike,
  solveZeroCostCollarStrike,
} from '@/lib/options/black-scholes';
import { rateForTenor, type TenorYears } from '@/lib/options/risk-free-rates';
import { SECTOR_STATS, type SectorKey } from '@/lib/markets/sector-stats';

// Drawdown the put protects against, as a fraction. UI clamps to [0.05, 0.50].
export type ProtectionLevel = number;

export type ProtectivePutInputs = {
  positionValue: number;
  sector: SectorKey;
  volatility: number;
  protectionLevel: ProtectionLevel;
  tenorYears: TenorYears;
  // When present, overrides SECTOR_STATS[sector].annualReturn as the long-run
  // drift μ used by the calc (capProbability, expectedProfit, badYearPrice).
  // Chain-driven UI passes chain.historicalReturn (trailing 5-yr annualized).
  expectedReturn?: number;
  // Optional human-readable label surfaced in warning copy. Chain-driven UI
  // passes chain.ticker (e.g. "AAPL"); legacy mode leaves it undefined and
  // the copy falls back to the sector label.
  tickerLabel?: string;
};

export type BarePutResult = {
  strike: number;
  premium: number;
  annualCost: number;
  annualCostPct: number;
  maxLoss: number;
  // Stock price at the BAD_YEAR_PERCENTILE under the sector's real-world
  // drift — used to determine whether the put fires in a typical bad year.
  badYearPrice: number;
  badYearDropPct: number;        // (S − badYearPrice) / S, always ≥ 0
  // What the put would pay at the bad-year price. 0 when the bad-year drop
  // doesn't reach the protection floor (put is tail-only insurance).
  coveredLossAtBadYear: number;
  // premium / coveredLossAtBadYear — "cents per dollar of bad-year coverage."
  // Catches the case where the floor is set too low: the put fires only on
  // a small slice of a typical bad-year drop, so most of the premium pays
  // for protection that doesn't activate. Infinity when coveredLoss = 0.
  premiumToCoveredRatio: number;
  // Expected profit over the tenor under the sector's long-run drift —
  // S × μ × T. Used as the denominator for the "how much of my expected
  // upside is this hedge eating?" criterion (catches shallow expensive puts).
  expectedProfit: number;
  // premium / expectedProfit — fraction of typical-year upside consumed by
  // the hedge premium.
  premiumToExpectedProfitRatio: number;
};

export type CollarResult = {
  putStrike: number;
  callStrike: number;
  netPremium: number;
  annualCost: number;
  annualCostPct: number;
  maxLoss: number;
  upsideCap: number;
  upsideCapPct: number;
  isZeroCost: boolean;
  // Real-world probability the stock breaks above K_call by expiration,
  // computed with the sector's long-run drift μ as the GBM drift.
  capProbability: number;
};

export type PayoffRow = {
  drawdownPct: number;
  barePutPnl: number;
  collarPnl: number;
  unhedgedPnl: number;
};

export type RecommendedStructure = 'collar' | 'protective-put' | 'none';

export type ProtectivePutResult = {
  inputs: ProtectivePutInputs;
  riskFreeRate: number;
  realWorldDrift: number;
  barePut: BarePutResult;
  collar: CollarResult;
  payoffTable: PayoffRow[];
  // Drawdown range used for the payoff table and chart. Always extends at
  // least 15% beyond each collar arm and at least ±50%.
  payoffRange: { lowerPct: number; upperPct: number };
  recommended: RecommendedStructure;
};

// Above this real-world cap-breach probability, the collar is no longer
// recommended — protective put becomes the suggested structure (provided the
// put cost is within reason). Tuned to ~1-in-5: at higher breach probabilities
// the user is giving up upside often enough that the bare-put premium is worth
// paying.
export const COLLAR_CAP_PROB_THRESHOLD = 0.20;

// "Bad year" percentile for sizing what the put is realistically expected to
// cover. 10% = "1-in-10 bad year" — recession-class drawdown for the user's
// sector. The price-at-percentile is computed under real-world drift, so
// higher-drift sectors land at less-bad bad-year prices.
export const BAD_YEAR_PERCENTILE = 0.10;
// Pre-computed Φ⁻¹(0.10). Hardcoded; replace with a normal-quantile helper
// if we ever expose the percentile to the user.
const BAD_YEAR_Z = -1.2815515655446;

// Premium-as-fraction-of-expected-profit threshold above which the put is
// "expensive." Above 0.50 means the hedge consumes more than half of the
// typical-year profits — catches the shallow-and-expensive case where the
// floor is set close to today's price.
export const PUT_EATS_UPSIDE_THRESHOLD = 0.50;

// Premium-to-bad-year-coverage ratio above which the floor is set too deep:
// the put fires only on a small slice of a typical bad-year drop, so most
// of the premium pays for protection that barely activates. Above 0.40,
// you're paying more than 40 cents per dollar of bad-year coverage.
export const PUT_COVERED_LOSS_RATIO = 0.40;

export function calculateProtectivePut(
  inputs: ProtectivePutInputs,
): ProtectivePutResult {
  const S = inputs.positionValue;
  const T = inputs.tenorYears;
  const sigma = inputs.volatility;
  const r = rateForTenor(T);
  const Kput = S * (1 - inputs.protectionLevel);

  const putPremium = blackScholesPut({
    spot: S,
    strike: Kput,
    riskFreeRate: r,
    volatility: sigma,
    timeYears: T,
  });

  const mu = inputs.expectedReturn ?? SECTOR_STATS[inputs.sector].annualReturn;
  const badYearPrice =
    S * Math.exp((mu - 0.5 * sigma * sigma) * T + BAD_YEAR_Z * sigma * Math.sqrt(T));
  const badYearDropPct = S > 0 ? (S - badYearPrice) / S : 0;
  const coveredLossAtBadYear = Math.max(Kput - badYearPrice, 0);
  const premiumToCoveredRatio =
    coveredLossAtBadYear > 0 ? putPremium / coveredLossAtBadYear : Infinity;
  const expectedProfit = S * mu * T;
  const premiumToExpectedProfitRatio =
    expectedProfit > 0 ? putPremium / expectedProfit : Infinity;
  const barePut: BarePutResult = {
    strike: Kput,
    premium: putPremium,
    annualCost: putPremium / T,
    annualCostPct: S > 0 ? putPremium / T / S : 0,
    maxLoss: S - Kput + putPremium,
    badYearPrice,
    badYearDropPct,
    coveredLossAtBadYear,
    premiumToCoveredRatio,
    expectedProfit,
    premiumToExpectedProfitRatio,
  };

  const { strike: Kcall, residual } = solveZeroCostCollarStrike({
    spot: S,
    riskFreeRate: r,
    volatility: sigma,
    timeYears: T,
    putPremium,
  });
  const callPremium = blackScholesCall({
    spot: S,
    strike: Kcall,
    riskFreeRate: r,
    volatility: sigma,
    timeYears: T,
  });
  const netPremium = Math.max(0, putPremium - callPremium);
  const capProbability = probAboveStrike({
    spot: S,
    strike: Kcall,
    drift: mu,
    volatility: sigma,
    timeYears: T,
  });
  const collar: CollarResult = {
    putStrike: Kput,
    callStrike: Kcall,
    netPremium,
    annualCost: netPremium / T,
    annualCostPct: S > 0 ? netPremium / T / S : 0,
    maxLoss: S - Kput + netPremium,
    upsideCap: Kcall - S,
    upsideCapPct: S > 0 ? (Kcall - S) / S : 0,
    isZeroCost: residual === 0 && netPremium < 1,
    capProbability,
  };

  // Always extend the visible range at least 15% beyond each collar arm and
  // at least to ±50%. Round outward to the nearest 10% so the table rows
  // line up cleanly.
  const upsideCapPct = collar.upsideCapPct;
  const lowerRaw = Math.min(-0.5, -inputs.protectionLevel - 0.15);
  const upperRaw = Math.max(0.5, upsideCapPct + 0.15);
  const lowerPct = Math.floor(lowerRaw * 10) / 10;
  const upperPct = Math.ceil(upperRaw * 10) / 10;
  const payoffRange = { lowerPct, upperPct };

  const payoffTable: PayoffRow[] = [];
  for (let d = lowerPct; d <= upperPct + 1e-9; d += 0.1) {
    const dRounded = Math.round(d * 10) / 10;   // dedupe floating-point drift
    payoffTable.push({
      drawdownPct: dRounded,
      barePutPnl: barePutPayoff(S, Kput, putPremium, dRounded),
      collarPnl: collarPayoff(S, Kput, Kcall, netPremium, dRounded),
      unhedgedPnl: S * dRounded,
    });
  }

  const collarCapsTooOften = capProbability > COLLAR_CAP_PROB_THRESHOLD;
  // "Expensive" in three distinct ways:
  //  - tail-only: the put doesn't fire at the typical bad year (covered = 0)
  //  - floor too deep: premium / coveredLoss > 0.40 (most of the premium
  //    pays for protection that barely activates)
  //  - floor too shallow: premium > 50% of expected upside (the hedge eats
  //    most of typical-year profits)
  const putIsExpensive =
    coveredLossAtBadYear === 0 ||
    premiumToCoveredRatio > PUT_COVERED_LOSS_RATIO ||
    premiumToExpectedProfitRatio > PUT_EATS_UPSIDE_THRESHOLD;
  // If the collar caps too often AND the put is expensive, neither structure is
  // a clean recommendation — surface no badge and let the user weigh the
  // trade-offs themselves.
  const recommended: RecommendedStructure = collarCapsTooOften
    ? putIsExpensive
      ? 'none'
      : 'protective-put'
    : 'collar';

  return {
    inputs,
    riskFreeRate: r,
    realWorldDrift: mu,
    barePut,
    collar,
    payoffTable,
    payoffRange,
    recommended,
  };
}

// Terminal P&L for a bare protective put at a given drawdown d (as a fraction
// of spot, e.g. −0.30 = stock down 30%).
//
// Position + put payoff at expiration:
//   if S_T < K:   K − S − premium      (floor is K − S − premium)
//   if S_T ≥ K:   S × d − premium      (down by premium vs. unhedged)
export function barePutPayoff(S: number, K: number, premium: number, d: number): number {
  const ST = S * (1 + d);
  if (ST < K) return K - S - premium;
  return S * d - premium;
}

// Terminal P&L for a zero-cost (or low-cost) collar at a given drawdown d.
//   if S_T < K_put:               K_put − S − netPremium
//   if K_put ≤ S_T ≤ K_call:      S × d − netPremium
//   if S_T > K_call:              K_call − S − netPremium
export function collarPayoff(
  S: number,
  Kput: number,
  Kcall: number,
  netPremium: number,
  d: number,
): number {
  const ST = S * (1 + d);
  if (ST < Kput) return Kput - S - netPremium;
  if (ST > Kcall) return Kcall - S - netPremium;
  return S * d - netPremium;
}

// Payoff curve for the chart. Spans result.payoffRange (always ≥10% beyond
// each collar arm) in `steps + 1` points.
export function buildPayoffCurve(
  result: ProtectivePutResult,
  steps = 100,
): PayoffRow[] {
  const S = result.inputs.positionValue;
  const Kput = result.barePut.strike;
  const Kcall = result.collar.callStrike;
  const putPremium = result.barePut.premium;
  const netPremium = result.collar.netPremium;
  const { lowerPct, upperPct } = result.payoffRange;
  const span = upperPct - lowerPct;
  const points: PayoffRow[] = [];
  for (let i = 0; i <= steps; i++) {
    const d = lowerPct + (span * i) / steps;
    points.push({
      drawdownPct: d,
      barePutPnl: barePutPayoff(S, Kput, putPremium, d),
      collarPnl: collarPayoff(S, Kput, Kcall, netPremium, d),
      unhedgedPnl: S * d,
    });
  }
  return points;
}
