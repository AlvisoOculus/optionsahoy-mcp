// AlphaLatitude Inc. © 2026
//
// Treasury yields keyed by tenor (years), used as the risk-free rate input
// to Black-Scholes. Refresh annually each January from FRED:
//   DGS6MO (6-month), DGS1 (1-year), DGS2 (2-year).
//
// Last reviewed: 2026-04-27.

// Tenor in years. Continuous; UI typically constrains to 1/12 .. 2.
export type TenorYears = number;

export const TREASURY_RATES = {
  0.5: 0.043,
  1: 0.045,
  2: 0.048,
} as const;

// Linear interpolation across the three anchor points. Falls back to the
// nearest anchor outside [0.5, 2].
export function rateForTenor(years: number): number {
  if (years <= 0.5) return TREASURY_RATES[0.5];
  if (years <= 1) {
    return TREASURY_RATES[0.5] + (TREASURY_RATES[1] - TREASURY_RATES[0.5]) * (years - 0.5) / 0.5;
  }
  if (years <= 2) {
    return TREASURY_RATES[1] + (TREASURY_RATES[2] - TREASURY_RATES[1]) * (years - 1);
  }
  return TREASURY_RATES[2];
}
