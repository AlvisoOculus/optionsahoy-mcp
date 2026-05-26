// AlphaLatitude Inc. © 2026
//
// Browser-side accessors for the option-chain data pipeline:
//   - chains/index.json    — list of tickers we've already cached (R2 CDN)
//   - chains/tickers.json  — full optionable-equity list for autocomplete
//   - chains/{T}.json      — per-ticker chain (R2 CDN, fast path)
//   - /chains/fetch/{T}    — Worker on-demand endpoint (slow path; misses
//                            R2 cache → calls Polygon → persists)
//
// Two URL bases:
//   NEXT_PUBLIC_OA_DATA_BASE     — public R2 root (data.optionsahoy.com)
//   NEXT_PUBLIC_OA_PIPELINE_BASE — Worker root (oa-options-pipeline.<acct>.workers.dev)

const DATA_BASE =
  process.env.NEXT_PUBLIC_OA_DATA_BASE ?? 'https://data.optionsahoy.com';
const PIPELINE_BASE =
  process.env.NEXT_PUBLIC_OA_PIPELINE_BASE ?? DATA_BASE;

export interface ChainSide {
  exp: string[];   // YYYY-MM-DD
  k: number[];     // strike
  price: number[]; // option close (USD)
}

// Mirror of workers/src/types.ts TICKER_CHAIN_SCHEMA_V — bump in lockstep when
// chain JSON shape or its computation logic changes in a way that should force
// re-fetch of cached entries.
export const TICKER_CHAIN_SCHEMA_V = 3;

export interface TickerChain {
  ticker: string;
  asOf: number;
  spot: number;
  calls: ChainSide;
  puts: ChainSide;
  // Trailing annualized total return + the actual elapsed window length.
  // Window depends on the Polygon plan tier; we annualize over what we get
  // and surface the years so UIs can label "AAPL 2-yr trailing" honestly.
  // Null/absent for new IPOs (window < 1y).
  historicalReturn?: number | null;
  historicalReturnYears?: number | null;
  schemaV?: number;
}

export interface IndexFile {
  tickers: string[];
  asOf: number;
  cycleId: string;
  version: number;
}

export interface TickerInfo {
  t: string;
  n: string;
}

export interface TickersFile {
  asOf: number;
  tickers: TickerInfo[];
}

export async function fetchIndex(): Promise<IndexFile | null> {
  return fetchJsonWithRetry<IndexFile>(`${DATA_BASE}/chains/index.json`, { cache: 'no-store' });
}

export async function fetchTickerList(): Promise<TickersFile | null> {
  return fetchJsonWithRetry<TickersFile>(`${DATA_BASE}/chains/tickers.json`, { cache: 'force-cache' });
}

/**
 * Fetch a ticker's chain. If `cachedTickers` includes it, hit the CDN directly
 * (fast). Otherwise call the Worker's on-demand endpoint, which fills R2 from
 * Polygon and serves the result. When the CDN copy is missing fields the
 * client expects (schema drift after a worker upgrade), fall through to the
 * Worker so the user sees fresh data without waiting for the next warm cycle.
 */
export async function fetchChain(
  ticker: string,
  cachedTickers: ReadonlySet<string>,
): Promise<TickerChain | null> {
  if (cachedTickers.has(ticker)) {
    const cached = await fetchJsonWithRetry<TickerChain>(`${DATA_BASE}/chains/${ticker}.json`);
    if (cached && hasCurrentSchema(cached)) return cached;
  }
  return fetchJsonWithRetry<TickerChain>(`${PIPELINE_BASE}/chains/fetch/${ticker}`);
}

// ── Retry helper ─────────────────────────────────────────────────────────
// Retries network errors and transient upstream signals (408/429/5xx). Other
// 4xx return null immediately — no point retrying a 400/404. Backoff: 200ms ×
// 2^attempt with ±25% jitter so concurrent retries don't thunder.

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

async function fetchJsonWithRetry<T>(url: string, init?: RequestInit): Promise<T | null> {
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(url, init);
      if (response.ok) return (await response.json()) as T;
      // Non-OK with non-retryable status: surface as null (callers all
      // tolerate null — page falls back to legacy mode / empty state).
      if (!isRetryableStatus(response.status)) return null;
    } catch {
      // Network error / JSON parse failure — retry unless we're out of attempts.
    }
    if (attempt === RETRY_MAX_ATTEMPTS - 1) return null;
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5);
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

// Schema gate mirrors the worker's: chains carry an explicit schemaV set by
// the writer. Anything older is treated as stale and the fetcher falls
// through to /chains/fetch/{T}, which rewrites the R2 entry on first hit.
function hasCurrentSchema(chain: TickerChain): boolean {
  return chain.schemaV === TICKER_CHAIN_SCHEMA_V;
}
