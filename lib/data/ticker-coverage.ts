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

import returns from './trailing-returns.json';
import { hasTrailingReturn } from './trailing-returns';
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
  // Universe = the CANONICAL symbols in either table. We deliberately do NOT
  // pull in coveredTickers()'s alias keys (e.g. GOOG -> GOOGL): counting an
  // alias as its own symbol double-counts (GOOG and GOOGL) and inflates every
  // headline, producing impossible numbers like "86 resolve volatility" when
  // the vols table has 85 rows. The tables are keyed by canonical symbol, so
  // their key union is exactly the distinct set; aliases still resolve at call
  // time via the readers, and the resource notes that.
  const universe = new Set<string>([...Object.keys(returns.tickers), ...Object.keys(vols.tickers)]);
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
