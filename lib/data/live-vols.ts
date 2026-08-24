// AlphaLatitude Inc. © 2026
//
// Reader for the PUBLISHED ATM 1y implied-volatility artifact. Lets MCP/REST
// callers pass a `ticker` instead of a `volatility` number — the parser
// substitutes the stock's own sigma so the LLM does not have to invent one.
//
// This replaced a snapshot baked into the npm package (lib/data/trailing-vols
// .json). That table shipped with the release and then aged: an install could
// be weeks past its last refresh and still hand back a confident number, which
// is precisely the "facts, not stale estimates" promise the no-defaults
// contract makes. The fix is not a faster bake — it is a READ-TIME FRESHNESS
// GATE. Every resolution either produces a sigma as of the last market close,
// or produces nothing at all and the caller gets the ordinary required-field
// error for `volatility`.
//
// ── Failure is always the same failure ───────────────────────────────────
// Fetch error, timeout, non-200, unparseable body, wrong schemaV, ticker
// absent, entry stale: every one of these returns null from getLiveVol, which
// is the EXACT signal an uncovered ticker produced under the baked table. So
// each call site keeps the behaviour it already had and documented — the drag
// -bearing parsers throw `field "volatility" required: ...`, protective_put
// falls back to its sector-typical IV. There is deliberately NO second source:
// no baked fallback, no estimate, no last-known-good beyond the memo TTL.
// A stale number that looks fresh is worse than no number.
//
// ── Runtimes ─────────────────────────────────────────────────────────────
// Both the Cloudflare Pages Functions runtime and the Node stdio server have
// global `fetch` and `AbortSignal.timeout`, so this needs no dependency and no
// per-runtime branch. Workers forbid I/O outside a request context, so the
// fetch is never issued at module load: request handlers call
// `warmVolSnapshot()` once, and the parsers (which are synchronous, and called
// from REST, MCP, A2A, Poe and the scenario deep-link builder alike) read the
// warmed memo synchronously via `getLiveVol`.

import { lastTradingDayCutoffMs } from './market-calendar';

/** Published by the chains worker; contract v1 is frozen (see below). */
export const VOLS_URL = 'https://data.optionsahoy.com/chains/vols.json';

/** The only artifact schema this reader accepts. A producer that bumps this
 *  has changed the meaning of a field; refusing the whole document is correct,
 *  and degrades to the required-field error rather than to a misread number. */
export const VOLS_SCHEMA_V = 1;

/** Short by design: a tool call must not sit behind a slow CDN. Exceeding it
 *  is a normal outcome, not an exception — the caller just gets asked for the
 *  number. */
export const VOLS_FETCH_TIMEOUT_MS = 3_000;

/** In-process memo lifetime. The artifact turns over once a trading day, so
 *  five minutes is far tighter than the data's own cadence while collapsing a
 *  burst of tool calls onto one fetch. FAILURES are memoized for the same TTL:
 *  a burst arriving during a CDN outage would otherwise pay the full timeout
 *  on every single call. */
export const VOLS_MEMO_TTL_MS = 5 * 60_000;

/** One ticker's entry. `asOf` is the SOURCE CHAIN's epoch-SECONDS timestamp,
 *  per ticker — not the artifact's build time, which is why the gate is
 *  per-entry and not per-document. */
export type LiveVolEntry = {
  atmIV1y: number;
  asOf: number;
  sourceCell?: unknown;
};

export type VolsArtifact = {
  schemaV: number;
  generatedAt?: string;
  vols: Record<string, LiveVolEntry>;
};

// Share-class aliases: user-typed ticker -> the class the chain pipeline
// tracks. Alphabet trades as GOOGL (class A, in the universe) and GOOG
// (class C); the classes track within fractions of a percent, so GOOG resolves
// to GOOGL's data rather than erroring as uncovered. Mirrors the same map in
// ./trailing-returns so the growth and vol shortcuts accept the same symbols.
const TICKER_ALIASES: Record<string, string> = { GOOG: 'GOOGL' };

function canonicalTicker(ticker: string): string {
  const t = ticker.toUpperCase();
  return TICKER_ALIASES[t] ?? t;
}

// `doc: null` is a remembered FAILURE, not an absent memo — see the TTL note.
type Memo = { at: number; doc: VolsArtifact | null };

let memo: Memo | null = null;
let inflight: Promise<void> | null = null;

function isFresh(m: Memo | null, nowMs: number): m is Memo {
  return m !== null && nowMs - m.at < VOLS_MEMO_TTL_MS;
}

// Structural validation only: reject anything that is not the frozen v1 shape.
// Per-ENTRY validation (finite IV in range, finite asOf, freshness) happens at
// read time in getLiveVol, so one malformed ticker cannot blank the document
// for every other ticker.
function asArtifact(raw: unknown): VolsArtifact | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaV !== VOLS_SCHEMA_V) return null;
  if (o.vols === null || typeof o.vols !== 'object' || Array.isArray(o.vols)) return null;
  return {
    schemaV: VOLS_SCHEMA_V,
    generatedAt: typeof o.generatedAt === 'string' ? o.generatedAt : undefined,
    vols: o.vols as Record<string, LiveVolEntry>,
  };
}

/**
 * Populate the memo if it is cold or expired. NEVER throws and never rejects:
 * a failed warm is a memoized null, which every reader treats as "this ticker
 * resolves no volatility". Safe to await unconditionally at the top of a
 * request handler.
 *
 * Concurrent callers share one in-flight fetch, so a burst of parallel tool
 * calls on a cold memo issues a single request.
 */
export async function warmVolSnapshot(): Promise<void> {
  if (isFresh(memo, Date.now())) return;
  if (inflight) return inflight;
  inflight = (async () => {
    let doc: VolsArtifact | null = null;
    try {
      const res = await fetch(VOLS_URL, {
        signal: AbortSignal.timeout(VOLS_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (res.ok) doc = asArtifact(await res.json());
    } catch {
      // Network error, DNS failure, abort on timeout, or a body that is not
      // JSON. All the same outcome: no snapshot.
      doc = null;
    }
    memo = { at: Date.now(), doc };
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * The published ATM 1y IV for `ticker`, or null when it cannot be resolved
 * FRESHLY. Synchronous: reads only the memo that `warmVolSnapshot()` filled.
 * An unwarmed memo resolves nothing, which is the same safe degradation as a
 * failed fetch.
 *
 * `now` is injectable for tests; production always uses the server clock,
 * never anything from the request.
 */
export function getLiveVol(ticker: string, now: Date = new Date()): number | null {
  if (!ticker) return null;
  // Memo lifetime is wall-clock ("have we refetched recently"); the freshness
  // gate below is data-date ("is this the last close"). They are independent,
  // so the injectable `now` drives only the gate.
  const m = memo;
  if (!isFresh(m, Date.now()) || m.doc === null) return null;
  // The schema check is BOTH sides of the boundary on purpose: the fetch path
  // already refuses a foreign document, and re-checking here means the gate is
  // stated in one readable place ("schemaV 1 AND as of the last close") and
  // holds for any future path that populates the memo.
  if (m.doc.schemaV !== VOLS_SCHEMA_V) return null;
  // Object.hasOwn, not a bare index: `ticker` is caller-supplied, and a symbol
  // like "constructor" or "__proto__" would otherwise read off Object.prototype.
  const symbol = canonicalTicker(ticker);
  if (!Object.hasOwn(m.doc.vols, symbol)) return null;
  const entry = m.doc.vols[symbol];
  if (!entry || typeof entry !== 'object') return null;

  // Same sanity bound the baked reader applied: a sigma outside (0, 5] is a
  // pipeline defect, not a volatile stock, and must not reach a calculator.
  const iv = entry.atmIV1y;
  if (typeof iv !== 'number' || !Number.isFinite(iv) || iv <= 0 || iv > 5) return null;

  // THE FRESHNESS GATE. `asOf` is epoch SECONDS of the source chain; the
  // cutoff is 00:00 UTC of the last trading day (see ./market-calendar for why
  // that day is strictly before today, and why the producer must agree).
  const asOf = entry.asOf;
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) return null;
  if (asOf * 1000 < lastTradingDayCutoffMs(now)) return null;

  return iv;
}

/** True when `ticker` resolves a fresh sigma right now. Kept as the single
 *  predicate any caller should ask, so nothing re-implements the gate. */
export function hasLiveVol(ticker: string, now: Date = new Date()): boolean {
  return getLiveVol(ticker, now) !== null;
}

/** Test seam. Tests inject a fixture document (or a remembered failure)
 *  instead of touching the network, so the suite never depends on the producer
 *  being deployed. `undefined` clears the memo back to cold. */
export function __setVolSnapshotForTests(doc: VolsArtifact | null | undefined, at: number = Date.now()): void {
  memo = doc === undefined ? null : { at, doc };
  inflight = null;
}
