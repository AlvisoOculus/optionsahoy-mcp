// AlphaLatitude Inc. © 2026
//
// Single computed source of truth for what the optional `ticker` shortcut
// actually resolves. Two independent bundled snapshots back the shortcut:
// trailing-returns (expected growth) and trailing-vols (volatility). They do
// not cover the same symbols, and `coveredTickers()` lists every trailing-
// returns key including recent IPOs whose 5y AND 10y returns are both null
// (they resolve no growth). So "how many symbols does the shortcut cover"
// has no single answer; this module partitions the union of both tables by
// what each symbol resolves, so descriptions, the covered-tickers resource,
// and tests all read the same live counts instead of drifting hardcoded ones.
//
// The partition is computed by the SAME predicates the parsers call
// (hasTrailingReturn / hasTrailingVol), so a symbol can never be bucketed as
// resolving a field the tool would then reject. That reuse is the point: it
// makes the "resource lists a rejected ticker" bug structurally impossible
// rather than merely test-detectable.

import { coveredTickers, hasTrailingReturn } from './trailing-returns';
import { hasTrailingVol } from './trailing-vols';
import vols from './trailing-vols.json';

export type TickerCoverage = {
  growthAndVol: string[]; // resolves both fields
  growthOnly: string[]; // resolves growth, pass volatility explicitly
  volOnly: string[]; // resolves volatility, pass a growth/return field explicitly
  neither: string[]; // in the universe but resolves nothing usable
};

// Computed on demand from the bundled tables (cheap: a few hundred lookups).
export function tickerCoverage(): TickerCoverage {
  // Universe = every symbol either table (or an accepted alias) knows about.
  // coveredTickers() already returns the trailing-returns keys plus aliases
  // (e.g. GOOG); union in the vol-table keys so a symbol that resolves only
  // volatility and is absent from the returns table is still partitioned.
  const universe = new Set<string>([...coveredTickers(), ...Object.keys(vols.tickers)]);
  const growthAndVol: string[] = [];
  const growthOnly: string[] = [];
  const volOnly: string[] = [];
  const neither: string[] = [];
  for (const t of [...universe].sort()) {
    const g = hasTrailingReturn(t);
    const v = hasTrailingVol(t);
    if (g && v) growthAndVol.push(t);
    else if (g) growthOnly.push(t);
    else if (v) volOnly.push(t);
    else neither.push(t);
  }
  return { growthAndVol, growthOnly, volOnly, neither };
}
