// AlphaLatitude Inc. © 2026
//
// Black-Scholes European put pricing. Used to estimate the cost of
// hedging a concentrated equity position with a 1-year OTM put.
//
// Estimates only — uses sector-typical realized volatility as a proxy
// for implied volatility, and ignores dividend yield. Real option
// prices vary with the implied-vol surface, dividends, and skew.

// Standard normal CDF via Abramowitz & Stegun 26.2.17 approximation.
// Max error ~1.5e-7 over the real line.
export function normalCdf(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y =
    1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);

  return 0.5 * (1 + sign * y);
}

export type BlackScholesArgs = {
  spot: number;          // S
  strike: number;        // K
  riskFreeRate: number;  // r (continuously compounded)
  volatility: number;    // σ (annualized)
  timeYears: number;     // T
  dividendYield?: number;// q
};

export function blackScholesPut(args: BlackScholesArgs): number {
  const { spot: S, strike: K, riskFreeRate: r, volatility: sigma, timeYears: T } = args;
  const q = args.dividendYield ?? 0;

  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return 0;

  const sigmaSqrtT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sigmaSqrtT;
  const d2 = d1 - sigmaSqrtT;

  return K * Math.exp(-r * T) * normalCdf(-d2) - S * Math.exp(-q * T) * normalCdf(-d1);
}

// P(S_T > K) under geometric Brownian motion with drift μ and vol σ.
//   ln(S_T / S_0) ~ N((μ − σ²/2)T, σ²T)
//   P(S_T > K) = Φ(d2)  where d2 = (ln(S/K) + (μ − σ²/2)T) / (σ√T)
//
// Use μ = real-world expected return for "what's the chance the cap breaks."
// Use μ = riskFreeRate for the risk-neutral version.
export function probAboveStrike(args: {
  spot: number;
  strike: number;
  drift: number;          // μ (continuously compounded annualized)
  volatility: number;     // σ (annualized)
  timeYears: number;      // T
}): number {
  const { spot: S, strike: K, drift: mu, volatility: sigma, timeYears: T } = args;
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return 0;
  const d2 = (Math.log(S / K) + (mu - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normalCdf(d2);
}

export function blackScholesCall(args: BlackScholesArgs): number {
  const { spot: S, strike: K, riskFreeRate: r, volatility: sigma, timeYears: T } = args;
  const q = args.dividendYield ?? 0;

  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return 0;

  const sigmaSqrtT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sigmaSqrtT;
  const d2 = d1 - sigmaSqrtT;

  return S * Math.exp(-q * T) * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
}

// Implied volatility: invert Black-Scholes for σ given a market price.
// Bisection on σ ∈ [0.01, 5.0]; price is monotonically increasing in σ for
// both calls and puts (vega > 0). Returns null if the target price is outside
// the achievable range (e.g. below intrinsic value or above the no-arbitrage
// upper bound).
export function impliedVolatility(args: {
  spot: number;
  strike: number;
  riskFreeRate: number;
  timeYears: number;
  price: number;
  optionType: 'call' | 'put';
  dividendYield?: number;
  tol?: number;
  maxIter?: number;
}): number | null {
  const { spot, strike, riskFreeRate, timeYears, price, optionType } = args;
  const q = args.dividendYield ?? 0;
  const tol = args.tol ?? 1e-4;
  const maxIter = args.maxIter ?? 80;

  if (spot <= 0 || strike <= 0 || timeYears <= 0 || price <= 0) return null;

  const priceAt = (sigma: number) => {
    const a = { spot, strike, riskFreeRate, volatility: sigma, timeYears, dividendYield: q };
    return optionType === 'call' ? blackScholesCall(a) : blackScholesPut(a);
  };

  let lo = 0.01;
  let hi = 5.0;
  // Bracket check.
  if (priceAt(hi) < price) return null;
  if (priceAt(lo) > price) return null;

  for (let i = 0; i < maxIter; i++) {
    const mid = 0.5 * (lo + hi);
    const p = priceAt(mid);
    if (Math.abs(p - price) < tol) return mid;
    if (p < price) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Zero-cost collar: solve for the call strike K_call where the call premium
// received equals the put premium paid. Net cash outlay = 0.
//
// Call premium is monotonically decreasing in strike (further-OTM call →
// cheaper), so bisection converges. Returns { strike, residual } — residual
// is positive when even the ceiling strike (3 × spot) doesn't sell for enough
// to cover the put. In that low-σ / tight-strike edge case the caller can
// surface "low-cost" instead of "zero-cost."
export function solveZeroCostCollarStrike(args: {
  spot: number;
  riskFreeRate: number;
  volatility: number;
  timeYears: number;
  putPremium: number;     // target call premium
  dividendYield?: number;
}): { strike: number; residual: number } {
  const { spot: S, riskFreeRate: r, volatility: sigma, timeYears: T, putPremium } = args;
  const q = args.dividendYield ?? 0;
  const callAt = (K: number) =>
    blackScholesCall({ spot: S, strike: K, riskFreeRate: r, volatility: sigma, timeYears: T, dividendYield: q });

  // Call premium is monotonically decreasing in strike on K ≥ 0.
  // Put premium for K_put < S is always less than ATM call premium (call has
  // intrinsic value S(1-e^-qT) plus time value; OTM put has only time value),
  // so the root lives in (S, ∞). Cap the search at a wide ceiling.
  const hi0 = S * 3;
  let lo = S;
  let hi = hi0;

  if (callAt(hi) >= putPremium) {
    // Ceiling call still sells for more than the put — happens only when the
    // put is essentially worthless. Cap the upside at the ceiling and report
    // zero residual; user sees an effectively-uncapped collar.
    return { strike: hi, residual: 0 };
  }

  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const prem = callAt(mid);
    if (Math.abs(prem - putPremium) < 1) {
      return { strike: mid, residual: 0 };
    }
    if (prem > putPremium) lo = mid;
    else hi = mid;
  }
  const strike = 0.5 * (lo + hi);
  const residual = Math.max(0, putPremium - callAt(strike));
  return { strike, residual };
}
