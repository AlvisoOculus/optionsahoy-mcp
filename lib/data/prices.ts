// AlphaLatitude Inc. © 2026
//
// Reader for the per-ticker current-price snapshot. Lets a caller (the Poe bot)
// SUGGEST a current price for a named stock instead of making the user type one,
// the same way the web tools prefill it. It is a dated snapshot, not a live
// quote, so the answer stays deterministic and the date is disclosed.
//
// Source-of-truth file is web/lib/public-prices.json in the optionsahoy_web repo
// (refreshed daily by the price ETL). Copied here verbatim; keep them in sync.

import data from './prices.json';

type PriceEntry = { price: number; asOf: string };

const PRICES = (data as { prices?: Record<string, PriceEntry> }).prices ?? {};

// Share-class aliases, matching trailing-returns.
const TICKER_ALIASES: Record<string, string> = { GOOG: 'GOOGL' };

function canonical(ticker: string): string {
  const t = ticker.toUpperCase();
  return TICKER_ALIASES[t] ?? t;
}

// Returns the snapshot price + as-of date for a covered ticker, or null.
export function getCurrentPrice(ticker: string): { price: number; asOf: string } | null {
  if (!ticker) return null;
  const e = PRICES[canonical(ticker)];
  if (!e || typeof e.price !== 'number' || e.price <= 0) return null;
  return { price: e.price, asOf: e.asOf };
}
