// AlphaLatitude Inc. © 2026
//
// Reader for the ATM 1y IV table. Lets MCP/REST callers pass a `ticker`
// instead of a `volatility` number — the parser substitutes the
// ETL-cached sigma so the LLM does not have to invent one.
//
// Source-of-truth file is web/lib/trailing-vols.json in the
// optionsahoy_web repo (refreshed daily by the Phase 4b ETL step in
// .github/workflows/etl-daily.yml). Copied here verbatim; keep them in
// sync.

import data from './trailing-vols.json';

export type TrailingVolEntry = {
  atmIV1y: number;
  asOf: string;
  sourceCell: { exp: string; k: number; tenorYears: number };
};

const TICKERS = data.tickers as Record<string, TrailingVolEntry>;

// Share-class aliases: user-typed ticker -> the class the daily ETL tracks.
// Alphabet trades as GOOGL (class A, in the universe) and GOOG (class C);
// the classes track within fractions of a percent, so GOOG resolves to
// GOOGL's data rather than erroring as uncovered.
const TICKER_ALIASES: Record<string, string> = { GOOG: 'GOOGL' };

function canonicalTicker(ticker: string): string {
  const t = ticker.toUpperCase();
  return TICKER_ALIASES[t] ?? t;
}

// Returns the cached ATM 1y IV for the given ticker, or null when the
// ticker is unknown or its entry lacks a usable IV. Horizon argument is
// reserved for future use (currently the table only stores a single
// ~1y IV per ticker; horizon-blending would require multi-tenor cells).
export function getTrailingVol(ticker: string): number | null {
  if (!ticker) return null;
  const entry = TICKERS[canonicalTicker(ticker)];
  if (!entry || typeof entry.atmIV1y !== 'number') return null;
  if (entry.atmIV1y <= 0 || entry.atmIV1y > 5) return null;
  return entry.atmIV1y;
}

export function hasTrailingVol(ticker: string): boolean {
  return getTrailingVol(ticker) !== null;
}

const TICKER_COUNT = Object.keys(TICKERS).length;

export function trailingVolsCoverage(): { total: number; refreshedAt: string } {
  return {
    total: TICKER_COUNT,
    refreshedAt: (data as { _refreshedAt?: string })._refreshedAt ?? '',
  };
}
