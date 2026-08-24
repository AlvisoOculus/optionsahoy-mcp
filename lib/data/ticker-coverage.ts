// AlphaLatitude Inc. © 2026
//
// Single computed source of truth for what the optional `ticker` shortcut
// resolves. Since the volatility shortcut moved to the published daily
// artifact (see ./live-vols), only ONE side of the shortcut is a static list:
// expected growth, from the bundled trailing-returns snapshot.
//
// `coveredTickers()` in ./trailing-returns lists every trailing-returns key,
// including recent IPOs whose 5y AND 10y returns are both null — those resolve
// NO growth, so membership is not the same question as resolvability. This
// module answers the resolvability question, and it does so by calling the
// SAME predicate the parsers call (hasTrailingReturn). That reuse is the
// point: it makes the "resource lists a ticker the tool then rejects" bug
// structurally impossible rather than merely test-detectable.
//
// There is deliberately no vol partition here any more. Volatility coverage is
// now a property of a document fetched at request time and gated on the last
// market close, so it can differ between two calls a minute apart and cannot
// be enumerated at module load (the Workers runtime forbids I/O there). The
// covered-tickers resource describes that mechanism instead of publishing a
// roster that would be stale the moment it was written.

import returns from './trailing-returns.json';
import { hasTrailingReturn } from './trailing-returns';

export type TickerCoverage = {
  growth: string[]; // resolves expected growth from a ticker alone
  noGrowth: string[]; // in the table but resolves no usable trailing CAGR
};

// Computed on demand from the bundled table (cheap: a few hundred lookups).
export function tickerCoverage(): TickerCoverage {
  // Universe = the CANONICAL symbols in the table. We deliberately do NOT pull
  // in coveredTickers()'s alias keys (e.g. GOOG -> GOOGL): counting an alias as
  // its own symbol double-counts and inflates the headline. Aliases still
  // resolve at call time via the reader, and the resource notes that.
  const growth: string[] = [];
  const noGrowth: string[] = [];
  for (const t of Object.keys(returns.tickers).sort()) {
    if (hasTrailingReturn(t)) growth.push(t);
    else noGrowth.push(t);
  }
  return { growth, noGrowth };
}
