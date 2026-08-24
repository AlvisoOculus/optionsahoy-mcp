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

// Where the sigma actually priced came from. Set once, at the single point of
// resolution (parseProtectivePutInput), and carried through the result's
// `inputs` echo so a caller can tell a stock-specific price from a
// sector-typical one. Never re-derive it downstream: a second guess at the
// source is exactly how an echo starts lying about the number beside it.
export type VolatilitySource = 'explicit' | 'ticker' | 'sector-default' | 'chain';

// How the legs were priced. "chain-skew": each leg is priced at the implied
// volatility of its own strike, read off the stock's live option chain, so the
// floor put carries the market's downside skew and the spread's short leg
// carries its own. "flat": every leg is priced at the single `volatility`
// above, which understates what OTM protection costs and overstates the rebate
// a deep short leg earns. Set once, beside volatilitySource, at the single
// point of resolution (parseProtectivePutInput); never re-derived downstream.
export type PricingMode = 'chain-skew' | 'flat';

export type ProtectivePutInputs = {
  positionValue: number;
  sector: SectorKey;
  volatility: number;
  // Provenance of `volatility`, set by the parser alongside the value itself.
  // Optional because direct (non-API) callers - the chain-driven UI, tests -
  // build inputs by hand with a sigma they already own; every API surface
  // parses its input, so the echo always carries it.
  volatilitySource?: VolatilitySource;
  // Provenance of the PRICING, set beside volatilitySource by the same
  // resolution point. Optional for the same reason: direct callers build inputs
  // by hand. A caller that supplies ivAtStrike is in chain mode whether or not
  // it labels itself; the label is what an API response can be read off.
  pricingMode?: PricingMode;
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
  // Put-spread floor breach risk: target probability the stock ENDS below the
  // spread's short (lower) strike at expiration. One of SPREAD_RISK_LEVELS;
  // defaults to DEFAULT_SPREAD_RISK when omitted.
  spreadRiskLevel?: number;
  // Strike-level implied volatility lookup. Chain-driven UI passes a closure
  // over chainImpliedVol so the spread's short leg is solved and priced at the
  // skewed σ for ITS strike (the skew is the market pricing the left tail —
  // pricing a deep-OTM short put at the long leg's σ would understate both
  // its premium and the breach probability). Legacy mode omits it and every
  // leg falls back to the flat `volatility` input.
  ivAtStrike?: (strike: number) => number | null;
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
  // (S − badYearPrice) / S. Normally positive (the bad year is a drawdown), but
  // goes NEGATIVE when the real-world drift is high enough that even the
  // BAD_YEAR_PERCENTILE outcome lands above today's price (e.g. a momentum name
  // with a triple-digit trailing return). Callers must format the sign rather
  // than assume a drop.
  badYearDropPct: number;
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

export type PutSpreadResult = {
  // False when the solved short strike lands at/above the protection floor
  // (the quantile price is above the floor — same situation as the put's
  // "tail-only" warning: no lower strike worth selling) or when the band or
  // rebate degenerates at extreme inputs. When false, every numeric field is
  // still populated from the attempted solve, but callers should render the
  // explanation (keyed on unavailableReason) instead of the numbers.
  available: boolean;
  // Why the spread is unavailable; null when available.
  //  - 'floor':     the 1-in-N quantile price sits at/above the protection
  //                 floor (or within 1% of position of it) — no lower strike
  //                 worth selling at this risk level.
  //  - 'no-rebate': the short leg doesn't reduce cost (deep-OTM skew or
  //                 degenerate pricing makes shortPremium ≥ longPremium, or
  //                 the short put prices at zero).
  unavailableReason: 'floor' | 'no-rebate' | null;
  // Long leg = the protective put (same strike + premium as barePut).
  longStrike: number;
  longPremium: number;
  // Short leg, solved so P(S_T < shortStrike) ≈ riskLevel.
  shortStrike: number;
  shortPremium: number;
  // σ used for the short leg (skewed when ivAtStrike is supplied).
  shortSigma: number;
  netPremium: number;
  annualCost: number;
  annualCostPct: number;
  // Loss if the stock ends anywhere in the protected band (floor holds):
  // S − longStrike + netPremium. Below shortStrike, losses resume
  // dollar-for-dollar on top of this.
  maxLossInBand: number;
  // longStrike − shortStrike: the spread's maximum payout.
  bandWidth: number;
  // shortStrike as a drop from today: (S − shortStrike) / S.
  shortStrikeDropPct: number;
  // Achieved P(S_T < shortStrike) under real-world drift and σ(shortStrike).
  // ≈ riskLevel; reported so the UI quotes the actual number after the
  // skew-aware fixed-point solve.
  breachProbability: number;
  // Echo of the preset the solve targeted.
  riskLevel: number;
  // shortPremium / longPremium — fraction of the put's cost rebated by the
  // short leg ("cuts the put's cost by 43%").
  savingsPct: number;
  // What the spread would pay at the bad-year price, capped at bandWidth.
  coveredLossAtBadYear: number;
};

export type PayoffRow = {
  drawdownPct: number;
  barePutPnl: number;
  collarPnl: number;
  // NaN when the spread is unavailable — callers skip the series.
  spreadPnl: number;
  unhedgedPnl: number;
};

export type RecommendedStructure = 'collar' | 'protective-put' | 'put-spread' | 'none';

// The hedge structures a user can pick in the UI (cards, chart emphasis).
// Shared by the calculator and chart components so the union can't drift.
export type HedgeKind = 'put' | 'collar' | 'spread';

// Map the engine recommendation onto the pickable kind ('none' → null).
export function hedgeKindOf(recommended: RecommendedStructure): HedgeKind | null {
  switch (recommended) {
    case 'collar': return 'collar';
    case 'protective-put': return 'put';
    case 'put-spread': return 'spread';
    default: return null;
  }
}

export type ProtectivePutResult = {
  inputs: ProtectivePutInputs;
  riskFreeRate: number;
  realWorldDrift: number;
  barePut: BarePutResult;
  collar: CollarResult;
  putSpread: PutSpreadResult;
  payoffTable: PayoffRow[];
  // Drawdown range used for the payoff table and chart. Always extends at
  // least 15% beyond each collar arm (and below the spread's short strike
  // when the spread is available) and at least ±50%.
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

// Put-spread floor breach risk presets: target probability the stock ends
// below the spread's short strike at expiration. Keys of Z_BY_RISK; the UI
// offers exactly these ("1 in 5" / "1 in 10" / "1 in 20" / "1 in 100").
export const SPREAD_RISK_LEVELS = [0.20, 0.10, 0.05, 0.01] as const;
export const DEFAULT_SPREAD_RISK = 0.10;

// Pre-computed standard-normal quantiles Φ⁻¹(p) for the supported
// percentiles. Hardcoded; replace with a normal-quantile helper if we ever
// expose arbitrary percentiles to the user.
const Z_BY_RISK: Record<string, number> = {
  '0.2': -0.8416212335729143,
  '0.1': -1.2815515655446004,
  '0.05': -1.6448536269514722,
  '0.01': -2.3263478740408408,
};
const BAD_YEAR_Z = Z_BY_RISK['0.1']!;

// p-quantile of the terminal price under GBM: S·exp((μ − σ²/2)T + z_p·σ√T).
// Shared by the bad-year price and the spread's short-strike solve so the
// two can never drift apart (at the 1-in-10 preset they are the same number
// when σ is flat).
function lognormalQuantile(
  S: number,
  mu: number,
  sigma: number,
  T: number,
  z: number,
): number {
  return S * Math.exp((mu - 0.5 * sigma * sigma) * T + z * sigma * Math.sqrt(T));
}

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

// Below this savings fraction, the spread's short leg rebates so little that
// the structure is effectively the outright put with extra legs — the card
// warns that the put protects all the way down for nearly the same premium.
export const SPREAD_THIN_REBATE_THRESHOLD = 0.10;

// Minimum protected band, as a fraction of position (equivalently, in
// percentage points of stock movement: bandWidth / S = shortStrikeDropPct −
// protectionLevel). Below this the spread protects only a thin sliver just
// under the floor and re-exposes you below it — nearly pointless. Happens
// when the floor is already deep relative to the chosen risk level's
// quantile (e.g. a −32% floor whose 1-in-10 bad year is only −33%).
export const SPREAD_NARROW_BAND_THRESHOLD = 0.05;

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
  const badYearPrice = lognormalQuantile(S, mu, sigma, T, BAD_YEAR_Z);
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

  const putSpread = solvePutSpread(inputs, {
    riskFreeRate: r,
    drift: mu,
    longStrike: Kput,
    longPremium: putPremium,
    badYearPrice,
  });

  // Always extend the visible range at least 15% beyond each collar arm
  // (and below the spread's short strike, so the resumed-loss slope is
  // visible) and at least to ±50%. Round outward to the nearest 10% so the
  // table rows line up cleanly.
  const upsideCapPct = collar.upsideCapPct;
  // Clamped at −100%: a stock cannot lose more than its full value, so the
  // range never shows negative prices even when the solved short strike sits
  // in the deep tail (negative-drift, high-σ names).
  const lowerRaw = Math.max(
    -1,
    Math.min(
      -0.5,
      -inputs.protectionLevel - 0.15,
      putSpread.available ? -putSpread.shortStrikeDropPct - 0.15 : 0,
    ),
  );
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
      spreadPnl: putSpread.available
        ? spreadPayoff(S, Kput, putSpread.shortStrike, putSpread.netPremium, dRounded)
        : NaN,
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
  // The spread faces the same expense tests as the put (on its net premium
  // and its band-capped bad-year coverage) plus two of its own: a rebate so
  // thin the outright put costs nearly the same but protects all the way
  // down, and a protected band so narrow the structure barely insures
  // anything below the floor. Any of these surfaces a warning on the card
  // and blocks the recommendation, so a card with no warning is always the
  // recommended one.
  const spreadBandFraction = S > 0 ? putSpread.bandWidth / S : 0;
  const spreadIsExpensive =
    putSpread.coveredLossAtBadYear === 0 ||
    putSpread.netPremium / Math.max(putSpread.coveredLossAtBadYear, 1e-9) >
      PUT_COVERED_LOSS_RATIO ||
    (expectedProfit > 0
      ? putSpread.netPremium / expectedProfit
      : Infinity) > PUT_EATS_UPSIDE_THRESHOLD ||
    putSpread.savingsPct < SPREAD_THIN_REBATE_THRESHOLD ||
    spreadBandFraction < SPREAD_NARROW_BAND_THRESHOLD;
  // Triage: collar unless it caps too often; then the put unless it's
  // expensive; then the spread (cheaper by construction) unless it's
  // unavailable or fails the same expense tests; then no badge — let the
  // user weigh the trade-offs themselves.
  const recommended: RecommendedStructure = collarCapsTooOften
    ? putIsExpensive
      ? putSpread.available && !spreadIsExpensive
        ? 'put-spread'
        : 'none'
      : 'protective-put'
    : 'collar';

  return {
    inputs,
    riskFreeRate: r,
    realWorldDrift: mu,
    barePut,
    collar,
    putSpread,
    payoffTable,
    payoffRange,
    recommended,
  };
}

// Solve the put spread's short (lower) strike so the real-world probability
// of ENDING below it at expiration matches the chosen risk preset, then price
// both legs. The short leg is solved and priced at σ(K_short) when the caller
// supplies ivAtStrike (chain mode): the quantile and σ depend on each other,
// so a short fixed-point iteration replaces the closed form. Skew slopes are
// modest, so 3 iterations converge well past display precision.
function solvePutSpread(
  inputs: ProtectivePutInputs,
  ctx: {
    riskFreeRate: number;
    drift: number;
    longStrike: number;
    longPremium: number;
    badYearPrice: number;
  },
): PutSpreadResult {
  const S = inputs.positionValue;
  const T = inputs.tenorYears;
  const { riskFreeRate: r, drift: mu, longStrike, longPremium, badYearPrice } = ctx;
  // Normalize to a supported preset: the z-table only covers
  // SPREAD_RISK_LEVELS, so an off-preset input snaps to the nearest preset
  // and the echoed riskLevel always matches the z the solve actually used.
  const requested = inputs.spreadRiskLevel ?? DEFAULT_SPREAD_RISK;
  const riskLevel = SPREAD_RISK_LEVELS.reduce((best, p) =>
    Math.abs(p - requested) < Math.abs(best - requested) ? p : best,
  );
  const z = Z_BY_RISK[String(riskLevel)]!;
  const sigmaAt = (K: number) => {
    const skewed = inputs.ivAtStrike?.(K);
    return skewed != null && Number.isFinite(skewed) && skewed > 0
      ? skewed
      : inputs.volatility;
  };

  let Kshort = lognormalQuantile(S, mu, inputs.volatility, T, z);
  for (let i = 0; i < 3; i++) {
    Kshort = Math.min(lognormalQuantile(S, mu, sigmaAt(Kshort), T, z), longStrike);
  }
  const shortSigma = sigmaAt(Kshort);
  const shortPremium = blackScholesPut({
    spot: S,
    strike: Kshort,
    riskFreeRate: r,
    volatility: shortSigma,
    timeYears: T,
  });
  const bandWidth = longStrike - Kshort;
  // Unavailable when the quantile price sits at/above the protection floor
  // (no lower strike worth selling — the put itself is tail-only relative to
  // this risk level; a band under 1% of the position is the same situation),
  // or when the rebate isn't a strict cost reduction (deep-OTM skew or
  // degenerate pricing at extreme inputs).
  const unavailableReason: PutSpreadResult['unavailableReason'] =
    S <= 0 || Kshort <= 0 || bandWidth < S * 0.01
      ? 'floor'
      : shortPremium <= 0 || shortPremium >= longPremium
      ? 'no-rebate'
      : null;
  const available = unavailableReason === null;
  const netPremium = Math.max(0, longPremium - shortPremium);
  const breachProbability =
    1 -
    probAboveStrike({
      spot: S,
      strike: Kshort,
      drift: mu,
      volatility: shortSigma,
      timeYears: T,
    });
  return {
    available,
    unavailableReason,
    longStrike,
    longPremium,
    shortStrike: Kshort,
    shortPremium,
    shortSigma,
    netPremium,
    annualCost: netPremium / T,
    annualCostPct: S > 0 ? netPremium / T / S : 0,
    maxLossInBand: S - longStrike + netPremium,
    bandWidth,
    shortStrikeDropPct: S > 0 ? (S - Kshort) / S : 0,
    breachProbability,
    riskLevel,
    savingsPct: longPremium > 0 ? shortPremium / longPremium : 0,
    coveredLossAtBadYear: Math.min(
      Math.max(longStrike - badYearPrice, 0),
      Math.max(bandWidth, 0),
    ),
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

// Terminal P&L for a put spread (long put at K_long, short put at K_short)
// at a given drawdown d. Inside the band the floor holds like a bare put;
// below K_short the short leg starts paying out against you and losses
// resume dollar-for-dollar, offset by the band's max payout.
//   if S_T ≥ K_long:              S × d − netPremium
//   if K_short ≤ S_T < K_long:    K_long − S − netPremium
//   if S_T < K_short:             S × d + (K_long − K_short) − netPremium
export function spreadPayoff(
  S: number,
  Klong: number,
  Kshort: number,
  netPremium: number,
  d: number,
): number {
  const ST = S * (1 + d);
  if (ST >= Klong) return S * d - netPremium;
  if (ST >= Kshort) return Klong - S - netPremium;
  return S * d + (Klong - Kshort) - netPremium;
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
  const spread = result.putSpread;
  const { lowerPct, upperPct } = result.payoffRange;
  const span = upperPct - lowerPct;
  const points: PayoffRow[] = [];
  for (let i = 0; i <= steps; i++) {
    const d = lowerPct + (span * i) / steps;
    points.push({
      drawdownPct: d,
      barePutPnl: barePutPayoff(S, Kput, putPremium, d),
      collarPnl: collarPayoff(S, Kput, Kcall, netPremium, d),
      spreadPnl: spread.available
        ? spreadPayoff(S, Kput, spread.shortStrike, spread.netPremium, d)
        : NaN,
      unhedgedPnl: S * d,
    });
  }
  return points;
}
