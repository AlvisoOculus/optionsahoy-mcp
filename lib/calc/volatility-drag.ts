// AlphaLatitude Inc. © 2026
//
// Volatility-drag helpers shared by the equity-projection calculators. Two
// views of the same GBM mean→median gap:
//   - volatilityDragAdjustedGrowth: per-year rate adjustment (g − σ²/2),
//     used by ISO when projecting FMV year-by-year.
//   - lognormalHaircut: terminal-price haircut 1 − exp(−σ²T/2), used by
//     NSO/RSU which already have a terminal price target.
// They compound to the same value over equal horizons.

import type { TickerChain } from '@/lib/data/chains';
import { chainImpliedVol } from '@/lib/data/chainPricing';

// Floored at -0.99 so a wildly-large σ² can't crash Math.pow(1+g, T).
export function volatilityDragAdjustedGrowth(growth: number, sigma: number): number {
  if (!Number.isFinite(sigma) || sigma <= 0) return growth;
  if (!Number.isFinite(growth)) return growth;
  return Math.max(-0.99, growth - 0.5 * sigma * sigma);
}

// Clamped to [0, 1] — a >100% haircut flips the price negative.
export function lognormalHaircut(sigma: number, years: number): number {
  if (!Number.isFinite(sigma) || sigma <= 0) return 0;
  if (!Number.isFinite(years) || years <= 0) return 0;
  const raw = 1 - Math.exp(-0.5 * sigma * sigma * years);
  return Math.max(0, Math.min(1, raw));
}

/**
 * Average call+put ATM implied volatility from the chain at the requested
 * holdYears. Used by both the NSO/RSU haircut path and the ISO vol-drag
 * path. Returns null when the chain has no usable cells (rare).
 */
export function chainAtmImpliedVol(
  chain: TickerChain,
  holdYears: number,
  today: Date = new Date(),
): number | null {
  const targetK = chain.spot;
  const targetT = Math.max(0.01, holdYears);
  const callIv = chainImpliedVol(chain, targetK, targetT, 'C', today);
  const putIv = chainImpliedVol(chain, targetK, targetT, 'P', today);
  const sigmas = [callIv?.sigma, putIv?.sigma].filter(
    (s): s is number => typeof s === 'number' && Number.isFinite(s) && s > 0,
  );
  if (sigmas.length === 0) return null;
  return sigmas.reduce((a, b) => a + b, 0) / sigmas.length;
}
