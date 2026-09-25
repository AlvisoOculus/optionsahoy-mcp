// AlphaLatitude Inc. © 2026
//
// Live reader for the trailing-returns (growth) table.
//
// The MCP used to resolve a ticker's growth only from a bundled copy of
// optionsahoy_web's web/lib/trailing-returns.json, and nothing kept the copy
// in sync. By 2026-09-24 it was dated 06-03 with 90 tickers while the web's
// table had 518, so ticker-named growth lookups failed tool calls for ~430
// symbols the web already covered. optionsahoy_web now publishes the table at
// https://optionsahoy.com/data/trailing-returns.json on every deploy, and this
// module reads it the way ./live-vols reads chains/vols.json.
//
// The bundled copy stays as the fallback: a failed or slow fetch, a malformed
// document, or one OLDER than the bundle all leave callers exactly where they
// were before this module existed. Never worse than the copy, usually newer.
//
// Parsers are synchronous (shared verbatim across MCP, REST, A2A and Poe), so
// the fetch happens at the request boundary via warmGrowthSnapshot(), called
// from warmForCall, and getTrailingReturn reads the memo.

import type { TrailingReturnEntry } from './trailing-returns';

// Guarded like ./data-base: this module is in the Pages Functions bundle, and a
// bare module-scope `process` reference fails the whole worker at publish.
const SITE_BASE =
  (typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_OA_SITE_BASE : undefined) ??
  'https://optionsahoy.com';
export const GROWTH_URL = `${SITE_BASE}/data/trailing-returns.json`;

const MEMO_TTL_MS = 60 * 60 * 1000; // the table changes once a day
const FETCH_TIMEOUT_MS = 1_500; // one attempt: the bundled fallback makes a retry not worth the latency

export type GrowthDoc = { refreshedAt: string; tickers: Record<string, TrailingReturnEntry> };

let memo: { at: number; doc: GrowthDoc | null } | null = null;
let inflight: Promise<void> | null = null;

function asDoc(raw: unknown): GrowthDoc | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o._refreshedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o._refreshedAt)) return null;
  if (o.tickers === null || typeof o.tickers !== 'object' || Array.isArray(o.tickers)) return null;
  return { refreshedAt: o._refreshedAt, tickers: o.tickers as Record<string, TrailingReturnEntry> };
}

export async function warmGrowthSnapshot(): Promise<void> {
  if (memo !== null && Date.now() - memo.at < MEMO_TTL_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    let doc: GrowthDoc | null = null;
    try {
      const res = await fetch(GROWTH_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (res.ok) doc = asDoc(await res.json());
    } catch {
      // Network error or timeout: the bundled table answers.
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
 * The live table when one is memoized, fresh, and at least as new as
 * `bundledRefreshedAt`; otherwise null, and the caller uses its bundle. Dates
 * are ISO YYYY-MM-DD, so string comparison orders them.
 */
export function liveGrowthTable(bundledRefreshedAt: string): Record<string, TrailingReturnEntry> | null {
  const m = memo;
  if (m === null || m.doc === null || Date.now() - m.at >= MEMO_TTL_MS) return null;
  if (m.doc.refreshedAt < bundledRefreshedAt) return null;
  return m.doc.tickers;
}

/** refreshedAt of the memoized live document ('' when none). */
export function liveGrowthRefreshedAt(): string {
  return memo?.doc?.refreshedAt ?? '';
}

/** Test seam: seed (or clear, with null) the memo without a network. */
export function __setGrowthSnapshotForTests(doc: GrowthDoc | null, at: number = Date.now()): void {
  memo = doc === null ? null : { at, doc };
}
