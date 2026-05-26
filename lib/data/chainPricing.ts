// AlphaLatitude Inc. © 2026
//
// Helpers for pricing options off a TickerChain. The chain stores discrete
// observations on a (strike, expiration, side) grid; user-requested (K, T)
// rarely lands on a grid cell exactly, so we invert Black-Scholes for σ at
// each cell and bilinear-interpolate σ at the target. The IV surface is
// smoother than the price surface, so this is more numerically stable than
// interpolating prices directly.

import { impliedVolatility } from '@/lib/options/black-scholes';
import { rateForTenor } from '@/lib/options/risk-free-rates';
import type { ChainSide, TickerChain } from './chains';

export type Side = 'C' | 'P';

export interface ChainLookup {
  exp: string;
  k: number;
  price: number;
  // Diagnostic distance metrics (relative to target).
  strikeDistance: number;
  tenorDistanceYears: number;
}

export interface ChainImpliedVolResult {
  sigma: number;
  // Source description for diagnostics — "exact cell", "interpolated K",
  // "interpolated T", "interpolated K+T", or "extrapolated".
  source:
    | 'exact'
    | 'interp-k'
    | 'interp-t'
    | 'interp-kt'
    | 'extrapolated';
  // The closest cell used (for "extrapolated" / fallback diagnostics).
  closestCell: ChainLookup;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_DAYS = 365.25;

function tenorYears(expIso: string, today: Date): number {
  const d = new Date(`${expIso}T00:00:00Z`);
  return (d.getTime() - today.getTime()) / (YEAR_DAYS * ONE_DAY_MS);
}

interface IvCell {
  k: number;
  sigma: number;
  price: number;
}

interface ExpRow {
  exp: string;
  tenor: number;
  cells: IvCell[];   // sorted by k ascending
}

function buildIvSurface(
  side: ChainSide,
  spot: number,
  today: Date,
  optionType: 'call' | 'put',
): ExpRow[] {
  const grouped = new Map<string, IvCell[]>();
  for (let i = 0; i < side.exp.length; i++) {
    const exp = side.exp[i]!;
    const k = side.k[i]!;
    const price = side.price[i]!;
    if (price <= 0) continue;
    const tenor = tenorYears(exp, today);
    if (tenor <= 0) continue;
    const sigma = impliedVolatility({
      spot,
      strike: k,
      riskFreeRate: rateForTenor(tenor),
      timeYears: tenor,
      price,
      optionType,
    });
    if (sigma === null || !Number.isFinite(sigma) || sigma <= 0) continue;
    let row = grouped.get(exp);
    if (!row) {
      row = [];
      grouped.set(exp, row);
    }
    row.push({ k, sigma, price });
  }
  const rows: ExpRow[] = [];
  for (const [exp, cells] of grouped) {
    cells.sort((a, b) => a.k - b.k);
    rows.push({ exp, tenor: tenorYears(exp, today), cells });
  }
  rows.sort((a, b) => a.tenor - b.tenor);
  return rows;
}

// Linear interp σ at target K within one expiration row. Bracket → linear;
// outside → snap to nearest endpoint.
function interpInK(row: ExpRow, targetK: number): { sigma: number; bracketed: boolean } {
  const cells = row.cells;
  if (cells.length === 0) return { sigma: NaN, bracketed: false };
  if (cells.length === 1) return { sigma: cells[0]!.sigma, bracketed: false };
  if (targetK <= cells[0]!.k) return { sigma: cells[0]!.sigma, bracketed: false };
  if (targetK >= cells[cells.length - 1]!.k) {
    return { sigma: cells[cells.length - 1]!.sigma, bracketed: false };
  }
  for (let i = 1; i < cells.length; i++) {
    const lo = cells[i - 1]!;
    const hi = cells[i]!;
    if (targetK >= lo.k && targetK <= hi.k) {
      const t = (targetK - lo.k) / (hi.k - lo.k);
      return { sigma: lo.sigma + t * (hi.sigma - lo.sigma), bracketed: true };
    }
  }
  return { sigma: cells[0]!.sigma, bracketed: false };
}

/**
 * Bilinear interpolation of implied volatility at a target (K, T).
 *   1. Compute σ for each chain cell (BS-invert price).
 *   2. Find expirations bracketing T (or snap to nearest).
 *   3. At each, interpolate σ across K.
 *   4. Interpolate σ between the two T-rows.
 * Returns null if the side has no usable cells.
 */
export function chainImpliedVol(
  chain: TickerChain,
  targetStrike: number,
  targetTenorYears: number,
  side: Side,
  today: Date = new Date(),
): ChainImpliedVolResult | null {
  const sideArr: ChainSide = side === 'C' ? chain.calls : chain.puts;
  const surface = buildIvSurface(
    sideArr,
    chain.spot,
    today,
    side === 'C' ? 'call' : 'put',
  );
  if (surface.length === 0) return null;

  // Flat closest cell for diagnostics + fallback.
  const closestCell = findClosestCell(sideArr, targetStrike, targetTenorYears, today);

  // Snap T to bracketing rows.
  let lo: ExpRow | null = null;
  let hi: ExpRow | null = null;
  for (const row of surface) {
    if (row.tenor <= targetTenorYears) lo = row;
    if (row.tenor >= targetTenorYears && hi === null) hi = row;
  }
  // Outside the range: extrapolate by snapping to the nearest end.
  if (!lo) lo = surface[0]!;
  if (!hi) hi = surface[surface.length - 1]!;

  const loK = interpInK(lo, targetStrike);
  const hiK = interpInK(hi, targetStrike);

  let sigma: number;
  let source: ChainImpliedVolResult['source'];
  if (lo.exp === hi.exp) {
    sigma = loK.sigma;
    source = loK.bracketed ? 'interp-k' : 'extrapolated';
  } else {
    const span = hi.tenor - lo.tenor;
    const t = span > 0 ? (targetTenorYears - lo.tenor) / span : 0;
    const tClamped = Math.max(0, Math.min(1, t));
    sigma = loK.sigma + tClamped * (hiK.sigma - loK.sigma);
    if (loK.bracketed && hiK.bracketed && tClamped > 0 && tClamped < 1) source = 'interp-kt';
    else if (tClamped > 0 && tClamped < 1) source = 'interp-t';
    else if (loK.bracketed || hiK.bracketed) source = 'interp-k';
    else source = 'extrapolated';
  }

  if (!Number.isFinite(sigma) || sigma <= 0) return null;
  if (!closestCell) return null;
  return { sigma, source, closestCell };
}

/**
 * Find the closest cell in the chain for a target (strike, tenor).
 * Distance is normalized: rel-K + rel-T. Useful for diagnostics and as a
 * tail fallback when the IV surface is empty.
 */
export function findClosestCell(
  side: ChainSide,
  targetStrike: number,
  targetTenorYears: number,
  today: Date,
): ChainLookup | null {
  if (side.exp.length === 0) return null;
  let bestIdx = -1;
  let bestScore = Infinity;
  for (let i = 0; i < side.exp.length; i++) {
    const k = side.k[i]!;
    const t = tenorYears(side.exp[i]!, today);
    if (t <= 0) continue;
    const dK = Math.abs(k - targetStrike) / Math.max(targetStrike, 1);
    const dT = Math.abs(t - targetTenorYears) / Math.max(targetTenorYears, 0.083);
    const score = dK + dT;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return {
    exp: side.exp[bestIdx]!,
    k: side.k[bestIdx]!,
    price: side.price[bestIdx]!,
    strikeDistance: Math.abs(side.k[bestIdx]! - targetStrike) / Math.max(targetStrike, 1),
    tenorDistanceYears: Math.abs(tenorYears(side.exp[bestIdx]!, today) - targetTenorYears),
  };
}
