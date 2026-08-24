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
import { canonicalTicker } from './trailing-returns';

/** Public R2 root the artifact is published under. Same override knob and same
 *  default as ./chains.ts's DATA_BASE, so a staging/preview deployment points
 *  BOTH readers at one origin instead of half of them. The `typeof process`
 *  guard is the only difference: chains.ts is browser/Next-only, while this
 *  module also loads inside a Cloudflare Pages Function, where a bare `process`
 *  reference throws unless nodejs_compat is on. */
const DATA_BASE =
  (typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_OA_DATA_BASE : undefined) ??
  'https://data.optionsahoy.com';

/** Published by the chains worker; contract v1 is frozen (see below). */
export const VOLS_URL = `${DATA_BASE}/chains/vols.json`;

/** WHY a ticker resolved no sigma, in the caller's words. Every failure mode
 *  reaches the caller through this one phrase, because the caller cannot tell
 *  them apart and MUST NOT be told a transient CDN failure means "we do not
 *  cover your stock" — a model reading that relays it to the user as fact.
 *  Exported so the parsers (and any future surface) interpolate one string
 *  instead of re-describing the mechanism from memory. */
export const VOL_UNRESOLVED_REASON =
  'not covered, or the volatility feed is temporarily unavailable';

/** The only artifact schema this reader accepts. A producer that bumps this
 *  has changed the meaning of a field; refusing the whole document is correct,
 *  and degrades to the required-field error rather than to a misread number. */
export const VOLS_SCHEMA_V = 1;

/** Short by design: a tool call must not sit behind a slow CDN. Exceeding it
 *  is a normal outcome, not an exception — the caller just gets asked for the
 *  number. */
export const VOLS_FETCH_TIMEOUT_MS = 3_000;

/** ── Retry policy, and why it is NOT ./chains.ts's ────────────────────────
 *  chains.ts retries three times with exponential backoff and jitter, because
 *  its caller is a browser page that can show a spinner for two seconds and
 *  the alternative is an empty chart. This reader's caller is a SYNCHRONOUS
 *  parser inside one tool call: nothing downstream can wait, and every
 *  millisecond spent here is a millisecond an agent sits blocked on a request
 *  that will very likely succeed on the first try. So: same spirit (a lone
 *  transient blip must not become five minutes of memoized failure — the memo
 *  remembers failures, which is exactly what makes a single 502 expensive),
 *  one tenth the patience. Two attempts, a fixed short backoff, and a hard
 *  overall budget that the per-attempt timeout is clamped to, so warm can
 *  never exceed VOLS_TOTAL_BUDGET_MS no matter how the attempts fall. */
export const VOLS_FETCH_ATTEMPTS = 2;
export const VOLS_RETRY_DELAY_MS = 250;
export const VOLS_TOTAL_BUDGET_MS = 4_000;

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
};

export type VolsArtifact = {
  schemaV: number;
  vols: Record<string, LiveVolEntry>;
};

// The wire document carries MORE than this: a top-level `generatedAt` and a
// per-entry `sourceCell` provenance blob, at least. They are deliberately not
// in the types above and not copied in asArtifact, because nothing here reads
// them and a type that lists a field implies someone checks it. The producer
// owns the full shape (optionsahoy_web/workers, the vols artifact writer); the
// frozen v1 contract is pinned from both sides by
// tests/fixtures/vols-artifact-v1.json. Extra keys are ignored, never
// rejected, so the producer can add fields without a lockstep release.

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
    vols: o.vols as Record<string, LiveVolEntry>,
  };
}

/** Transient upstream signals worth a second try. Anything else (404, 403, a
 *  200 whose body is not the v1 schema) is a deployment or contract fact that
 *  a retry 250ms later cannot change. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

type Attempt = { doc: VolsArtifact | null; retryable: boolean };

async function fetchVolsOnce(timeoutMs: number): Promise<Attempt> {
  try {
    const res = await fetch(VOLS_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    // A 200 that fails asArtifact is a CONTRACT miss, not a blip: retrying
    // fetches the same bytes. Definitive.
    if (res.ok) return { doc: asArtifact(await res.json()), retryable: false };
    return { doc: null, retryable: isRetryableStatus(res.status) };
  } catch {
    // Network error, DNS failure, abort on timeout, or a truncated body that
    // failed to parse as JSON. All plausibly transient.
    return { doc: null, retryable: true };
  }
}

/**
 * Populate the memo if it is cold or expired. NEVER throws and never rejects:
 * a failed warm is a memoized null, which every reader treats as "this ticker
 * resolves no volatility". Safe to await unconditionally at the top of a
 * request handler — and safe to START without awaiting, then await later
 * (functions/poe.ts overlaps it with its billing round-trip).
 *
 * Concurrent callers share one in-flight fetch, so a burst of parallel tool
 * calls on a cold memo issues a single request.
 *
 * DEFERRED (recorded so it is not re-litigated): stale-while-revalidate — serve
 * the expired memo immediately and refresh in the background — would take the
 * refetch off the request path entirely. It needs a Workers `ctx.waitUntil`
 * threaded from every handler down to here, which is a signature change on five
 * surfaces plus a no-op shim for the Node stdio server. Deferred until the lazy
 * warm gate (mayResolveVolFromTicker, see functions/_lib/calc-parsers.ts) is
 * shown to be insufficient: it already removes this fetch from the majority of
 * calls, which is the same latency win for none of the plumbing.
 *
 * ALSO DEFERRED: generalizing this file into a reusable "gated published
 * artifact" reader (fetch + memo + schema gate + freshness gate, parameterized).
 * There is exactly one artifact today. A second one (the growth table, when it
 * stops being baked) is the trigger; abstracting ahead of it would be guessing
 * at which parts are the varying parts.
 */
export async function warmVolSnapshot(): Promise<void> {
  if (isFresh(memo, Date.now())) return;
  if (inflight) return inflight;
  inflight = (async () => {
    const deadline = Date.now() + VOLS_TOTAL_BUDGET_MS;
    let doc: VolsArtifact | null = null;
    for (let attempt = 0; attempt < VOLS_FETCH_ATTEMPTS; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const got = await fetchVolsOnce(Math.min(VOLS_FETCH_TIMEOUT_MS, remaining));
      if (got.doc !== null || !got.retryable) {
        doc = got.doc;
        break;
      }
      if (attempt === VOLS_FETCH_ATTEMPTS - 1) break;
      const delay = Math.min(VOLS_RETRY_DELAY_MS, deadline - Date.now());
      if (delay <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
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

/** Test seam. Tests inject a fixture document (or a remembered failure)
 *  instead of touching the network, so the suite never depends on the producer
 *  being deployed. `undefined` clears the memo back to cold. */
export function __setVolSnapshotForTests(doc: VolsArtifact | null | undefined, at: number = Date.now()): void {
  memo = doc === undefined ? null : { at, doc };
  inflight = null;
}
