// AlphaLatitude Inc. © 2026
//
// Reader for the trailing-CAGR table. Lets MCP/REST callers pass a
// `ticker` instead of an `expectedPositionReturn` / `expectedGrowth` /
// `expectedMarketReturn` number — the parser substitutes the trailing
// return so the LLM does not have to invent one.
//
// Source-of-truth file is web/lib/trailing-returns.json in the
// optionsahoy_web repo (refreshed daily by the Yahoo ETL). Copied here
// verbatim; keep them in sync.

import data from './trailing-returns.json';

export type TrailingReturnEntry = {
  return5y: number | null;
  return10y: number | null;
  earliestSpanYears: number;
  asOf: string;
};

const TICKERS = data.tickers as Record<string, TrailingReturnEntry>;

// Share-class aliases: user-typed ticker -> the class the daily ETL tracks.
// Alphabet trades as GOOGL (class A, in the universe) and GOOG (class C);
// the classes track within fractions of a percent, so GOOG resolves to
// GOOGL's data rather than erroring as uncovered.
const TICKER_ALIASES: Record<string, string> = { GOOG: 'GOOGL' };

function canonicalTicker(ticker: string): string {
  const t = ticker.toUpperCase();
  return TICKER_ALIASES[t] ?? t;
}

// Horizon-weighted blend of return5y and return10y. Below 3y → 100% 5y;
// at 10y+ → 100% 10y; linear blend in between. Returns null for unknown
// tickers or missing data. The web reader skips short horizons in favor
// of a separate chain-derived 2y signal; the MCP server has no chain
// access, so 5y is the closest substitute for short windows.
export function getTrailingReturn(ticker: string, horizonYears: number): number | null {
  if (!ticker || !Number.isFinite(horizonYears) || horizonYears <= 0) return null;
  const entry = TICKERS[canonicalTicker(ticker)];
  if (!entry) return null;
  const r5 = typeof entry.return5y === 'number' ? entry.return5y : null;
  const r10 = typeof entry.return10y === 'number' ? entry.return10y : null;
  if (r5 === null && r10 === null) return null;
  if (r5 === null) return r10;
  if (r10 === null) return r5;
  const alpha = Math.max(0, Math.min(1, (horizonYears - 3) / 7));
  return (1 - alpha) * r5 + alpha * r10;
}

// True when the ticker is in the registry with at least one usable CAGR.
// Used by parsers to decide whether to substitute a ticker for a missing
// growth-rate input or fall through to "user must supply it" errors.
export function hasTrailingReturn(ticker: string): boolean {
  if (!ticker) return false;
  const entry = TICKERS[canonicalTicker(ticker)];
  if (!entry) return false;
  return typeof entry.return5y === 'number' || typeof entry.return10y === 'number';
}

const TICKER_COUNT = Object.keys(TICKERS).length;

export function trailingReturnsCoverage(): { total: number; refreshedAt: string } {
  return {
    total: TICKER_COUNT,
    refreshedAt: (data as { _refreshedAt?: string })._refreshedAt ?? '',
  };
}

// The public symbols whose expected growth the `ticker` auto-fill resolves,
// sorted, for agents/tooling that want to enumerate the set instead of probing
// it. Includes accepted aliases (e.g. GOOG -> GOOGL) so the list matches what
// the parser actually accepts. Live from the bundled ETL snapshot, so it tracks
// the deployed data (no hand-maintained list to drift). Note: this returns every
// table key, so a few recent-IPO symbols here have null 5y AND 10y returns and
// resolve NO growth yet, and volatility comes from a separate smaller table
// (trailing-vols). For the accurate per-field partition, see tickerCoverage()
// in ./ticker-coverage and the covered-tickers MCP resource built from it.
export function coveredTickers(): string[] {
  return [...Object.keys(TICKERS), ...Object.keys(TICKER_ALIASES)].sort();
}
