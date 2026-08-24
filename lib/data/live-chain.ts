// AlphaLatitude Inc. © 2026
//
// Reader for ONE ticker's live option chain, used by protective_put_price to
// price each leg at its own strike's implied volatility instead of at a single
// flat sigma.
//
// ── Why a second reader, next to ./live-vols ─────────────────────────────
// ./live-vols reads a published ATM 1-year sigma per ticker: one number, one
// document, every covered symbol. That number is enough to price a hedge
// "roughly like this stock", and it is what every drag-bearing tool uses. It
// is NOT enough to price a hedge AT A STRIKE. The option market charges more
// for downside protection than the at-the-money sigma implies (the skew), so a
// 20%-out-of-the-money put quoted at the ATM sigma is quoted too cheap, and a
// put spread's short leg (deeper still) is quoted cheapest of all, which
// overstates the rebate that leg earns. The chain carries the whole surface,
// so this reader fetches it and ./chainPricing interpolates sigma at whatever
// strike the caller actually needs.
//
// ── Same failure discipline as ./live-vols ───────────────────────────────
// Fetch error, timeout, non-200, unparseable body, wrong schemaV, chain older
// than the last market close: every one returns null from getLiveChain, and
// the single consumer (parseProtectivePutInput) falls back to the flat-sigma
// ladder it used before this file existed, disclosed as pricingMode "flat".
// Nothing here can turn a hedge quote into an error, which is the one real
// difference from ./live-vols and the reason this reader does not retry: a
// failed chain costs a caller precision, not an answer.
//
// ── The stale-serve case, which is specific to this endpoint ─────────────
// /chains/fetch/{T} serves 543 daily-warmed tickers out of cache. An unwarmed
// symbol triggers a budgeted upstream fetch, and when that budget is spent the
// route answers with either 429 or a STALE cached chain. A 429 is a failed
// fetch and lands on the flat path by itself; the stale body arrives as a
// perfectly well-formed 200 and is caught here by the freshness gate, which is
// the same asOf-versus-last-close rule ./live-vols applies per entry. Two
// sides checking the same fact is deliberate: the producer decides what it can
// afford to serve, and this consumer decides what it is willing to price.

import { DATA_BASE } from './data-base';
import { isAsOfFresh } from './market-calendar';
import { canonicalTicker } from './trailing-returns';
import { TICKER_CHAIN_SCHEMA_V, type TickerChain } from './chains';

/** The on-demand endpoint, not the R2 object: it guarantees freshness on serve
 *  (refetching upstream when the cached copy has aged out) where `chains/{T}
 *  .json` is whatever the last warm cycle left behind. */
export function chainUrl(ticker: string): string {
  return `${DATA_BASE}/chains/fetch/${encodeURIComponent(ticker)}`;
}

/** The only chain schema this reader accepts, mirrored from ./chains (which
 *  mirrors the worker). A producer that bumps this has changed what a field
 *  means; refusing the document degrades to flat pricing, never to a misread
 *  surface. */
export const CHAIN_SCHEMA_V = TICKER_CHAIN_SCHEMA_V;

/** One tool call must not sit behind a slow origin. Slightly looser than the
 *  vols reader's 3s because a cold symbol can cost the worker an upstream
 *  round-trip, and still far under any client's patience. Exceeding it is an
 *  ordinary outcome: the caller gets the flat-sigma answer. */
export const CHAIN_FETCH_TIMEOUT_MS = 4_000;

/** In-process memo lifetime, per ticker. The chain turns over once a trading
 *  day, so five minutes collapses a burst of calls onto one fetch while
 *  staying far tighter than the data's own cadence. FAILURES are memoized for
 *  the same TTL, so a burst during an outage pays one timeout, not one per
 *  call. */
export const CHAIN_MEMO_TTL_MS = 5 * 60_000;

/** Distinct tickers held at once. A chain is ~20KB, and the stdio server is a
 *  process that can live for days, so the memo is bounded rather than left to
 *  grow with every symbol a session mentions. Well above any single
 *  conversation's working set; eviction drops the oldest entry, which costs
 *  one refetch. */
export const CHAIN_MEMO_MAX_ENTRIES = 32;

/** Symbols we are willing to put in a URL path. Same shape the scenario
 *  encoder accepts as a ticker label. Anything else is refused before the
 *  fetch: `ticker` is caller-supplied, and a symbol is a symbol, not a path. */
const TICKER_RE = /^[A-Z0-9.-]{1,8}$/;

// `chain: null` is a remembered FAILURE, not an absent entry.
type Memo = { at: number; chain: TickerChain | null };

const memo = new Map<string, Memo>();
const inflight = new Map<string, Promise<void>>();

function isFresh(m: Memo | undefined, nowMs: number): m is Memo {
  return m !== undefined && nowMs - m.at < CHAIN_MEMO_TTL_MS;
}

/** Structural validation only: the shape the interpolator indexes into. Every
 *  per-value judgement (freshness, sane spot) happens at read time in
 *  getLiveChain, so the gate is stated in one readable place. */
function asChain(raw: unknown, symbol: string): TickerChain | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaV !== CHAIN_SCHEMA_V) return null;
  if (typeof o.ticker !== 'string' || canonicalTicker(o.ticker) !== symbol) return null;
  if (!isSide(o.calls) || !isSide(o.puts)) return null;
  return o as unknown as TickerChain;
}

/** A chain side is three parallel arrays. Equal lengths are load-bearing:
 *  ./chainPricing walks `exp` and indexes `k` and `price` by the same i, so a
 *  short array would read undefined and produce NaN sigmas rather than fail. */
function isSide(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.exp) || !Array.isArray(s.k) || !Array.isArray(s.price)) return false;
  return s.exp.length === s.k.length && s.k.length === s.price.length;
}

function remember(symbol: string, chain: TickerChain | null): void {
  if (!memo.has(symbol) && memo.size >= CHAIN_MEMO_MAX_ENTRIES) {
    // Expired entries first: they are already unreadable (every getLiveChain
    // rechecks the TTL), so holding their ~20KB of JSON until the cap forces
    // them out is pure retention. Only when none has expired does the bound
    // bite, and then Map's insertion order makes the first key the oldest
    // WRITE - a size bound, not a cache policy.
    const now = Date.now();
    for (const [key, entry] of memo) {
      if (!isFresh(entry, now)) memo.delete(key);
    }
    if (memo.size >= CHAIN_MEMO_MAX_ENTRIES) {
      const oldest = memo.keys().next();
      if (!oldest.done) memo.delete(oldest.value);
    }
  }
  memo.set(symbol, { at: Date.now(), chain });
}

/**
 * Populate the memo for one ticker if it is cold or expired. NEVER throws and
 * never rejects: a failed warm is a memoized null, which the reader treats as
 * "this ticker prices flat". Safe to await unconditionally at a request
 * boundary, and gated there so only a protective_put_price call carrying a
 * `ticker` pays for it (see chainTickerFor in functions/_lib/calc-parsers.ts).
 *
 * Concurrent callers on the same symbol share one in-flight fetch.
 *
 * NO RETRY, unlike ./live-vols and unlike ./chains' browser-side fetcher. The
 * two of them retry because their caller has no acceptable degraded mode (an
 * error to the user, an empty chart). This one's caller has a good one: it
 * prices the hedge at the published flat sigma and says so. Spending a second
 * round-trip - and, on a 429, hammering an origin that just told us it is out
 * of budget - to sharpen a number we can already produce is the wrong trade.
 */
export async function warmChain(ticker: string): Promise<void> {
  const symbol = canonicalTicker(ticker.trim());
  if (!TICKER_RE.test(symbol)) return;
  if (isFresh(memo.get(symbol), Date.now())) return;
  const running = inflight.get(symbol);
  if (running) return running;
  const task = (async () => {
    let chain: TickerChain | null = null;
    try {
      const res = await fetch(chainUrl(symbol), {
        signal: AbortSignal.timeout(CHAIN_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      // Non-200 covers the budget-exhausted 429 and every other refusal; the
      // body is not a chain and there is nothing to keep.
      if (res.ok) chain = asChain(await res.json(), symbol);
    } catch {
      // Network error, DNS failure, abort on timeout, or a truncated body.
    }
    remember(symbol, chain);
  })();
  inflight.set(symbol, task);
  try {
    await task;
  } finally {
    inflight.delete(symbol);
  }
}

/**
 * The live chain for `ticker`, or null when it cannot be resolved FRESHLY.
 * Synchronous: reads only the memo that warmChain() filled, so the parsers
 * (which are synchronous, and shared by REST, MCP, A2A, Poe and stdio alike)
 * can consult it inline. An unwarmed memo resolves nothing, which is the same
 * safe degradation as a failed fetch.
 *
 * `now` is injectable for tests; production always uses the server clock,
 * never anything from the request.
 */
export function getLiveChain(ticker: string, now: Date = new Date()): TickerChain | null {
  if (!ticker) return null;
  const symbol = canonicalTicker(ticker.trim());
  // Memo lifetime is wall-clock ("have we refetched recently"); the freshness
  // gate below is data-date ("is this the last close"). Independent, so the
  // injectable `now` drives only the gate.
  const m = memo.get(symbol);
  if (!isFresh(m, Date.now()) || m.chain === null) return null;
  const chain = m.chain;
  // Both sides of the boundary check the schema on purpose: the fetch path
  // already refuses a foreign document, and re-checking here states the whole
  // gate in one place and holds for any future path that fills the memo.
  if (chain.schemaV !== CHAIN_SCHEMA_V) return null;

  // A chain with no spot prices nothing: every strike the caller asks about is
  // derived from it.
  if (typeof chain.spot !== 'number' || !Number.isFinite(chain.spot) || chain.spot <= 0) return null;

  // THE FRESHNESS GATE, the same predicate ./live-vols applies to a vols entry
  // (see ./market-calendar). This is what rejects a stale chain served by a
  // budget-exhausted worker: it arrives as a healthy 200 and is refused here.
  if (!isAsOfFresh(chain.asOf, now)) return null;

  return chain;
}

/**
 * Test seam: replace the memo with exactly these entries. A `null` value is a
 * remembered failure, an absent symbol is a cold memo. `{}` empties it, which
 * is the suite's default (tests/setup-market-data.ts) and means every ticker
 * prices flat unless a test seeds one.
 *
 * There is no "offline" switch here: the suite blocks the network globally, so
 * a symbol nobody seeded resolves nothing for the same reason production would
 * on an unreachable feed, through the same code path.
 */
export function __setChainsForTests(
  chains: Record<string, TickerChain | null>,
  at: number = Date.now(),
): void {
  memo.clear();
  inflight.clear();
  for (const [ticker, chain] of Object.entries(chains)) {
    memo.set(canonicalTicker(ticker), { at, chain });
  }
}
