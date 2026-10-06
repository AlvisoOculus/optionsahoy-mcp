// AlphaLatitude Inc. © 2026
//
// Which tickers callers ask about, and whether we could serve them: the demand
// signal for growing market-data coverage (and for spotting a tool gap behind
// a cluster of symbols). Recorded as DAILY COUNTS only (mcp_ticker_daily: day,
// ticker, tool, outcome, n), never per call, so it holds no figures and no
// link to a caller.
//
// Outcomes, per ticker named in a call:
//   ok        the call succeeded on that ticker's own market data
//   fallback  it succeeded, but some of that ticker's data was missing and a
//             disclosed substitute was used (the S&P 500 growth average, or a
//             sector-typical volatility for a hedge)
//   error     the call failed. Often for an unrelated missing field, but a
//             ticker whose volatility cannot be resolved also lands here: the
//             single-sigma tools throw rather than estimate one.

import { isMarketSentinel } from './calc-parsers';

export type TickerOutcome = 'ok' | 'fallback' | 'error';

export interface TickerUse {
  ticker: string;
  outcome: TickerOutcome;
}

// A plausible exchange symbol after upper-casing (BRK.B, BF-B, ^GSPC). Anything
// else (a company name, a sentence) is not counted: this table is a list of
// symbols, and free text has no business in it.
const SYMBOL = /^[A-Z^][A-Z0-9.\-]{0,11}$/;

function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The distinct, upper-cased symbols a call names: `ticker`, and each `stacks[].ticker`. */
export function namedTickers(args: unknown): string[] {
  const o = asObject(args);
  if (o === null) return [];
  const raw: unknown[] = [o.ticker];
  if (Array.isArray(o.stacks)) {
    for (const s of o.stacks) raw.push(asObject(s)?.ticker);
  }
  const out = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string' || isMarketSentinel(t)) continue;
    const sym = t.trim().toUpperCase();
    if (SYMBOL.test(sym)) out.add(sym);
  }
  return [...out];
}

// True when the result says this ticker's own data was not used somewhere:
// a growth assumption naming it, or a hedge priced at a sector-typical sigma.
function fellBack(ticker: string, result: Record<string, unknown>): boolean {
  const assumptions = Array.isArray(result.assumptions) ? result.assumptions : [];
  const named = `"${ticker}"`;
  for (const a of assumptions) {
    const reason = asObject(a)?.reason;
    if (typeof reason === 'string' && reason.toUpperCase().includes(named)) return true;
  }
  return asObject(result.inputs)?.volatilitySource === 'sector-default';
}

/** One row per ticker the call named, with how the call went for it. */
export function tickerUses(args: unknown, result: unknown, isError: boolean): TickerUse[] {
  const tickers = namedTickers(args);
  if (tickers.length === 0) return [];
  const r = isError ? null : asObject(result);
  return tickers.map((ticker) => ({
    ticker,
    outcome: isError ? 'error' : r !== null && fellBack(ticker, r) ? 'fallback' : 'ok',
  }));
}
