// AlphaLatitude Inc. © 2026
//
// The read-time volatility freshness gate.
//
// The contract this file pins down: a `ticker` either resolves an implied vol
// as of the last market close, or resolves NOTHING and the caller gets the
// same required-field error an uncovered ticker has always produced. There is
// no third outcome — no stale value, no baked fallback, no estimate.
//
// Everything here is fixture-driven. Nothing touches the network: `fetch` is
// stubbed per test, so the suite is green whether or not the producing worker
// has ever been deployed. That is also the property that makes this PR safe to
// merge first (see the 404 test at the bottom).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  VOLS_URL,
  VOLS_MEMO_TTL_MS,
  VOLS_FETCH_TIMEOUT_MS,
  VOLS_FETCH_ATTEMPTS,
  VOLS_TOTAL_BUDGET_MS,
  getLiveVol,
  warmVolSnapshot,
  __setVolSnapshotForTests,
} from '../lib/data/live-vols';
import { lastTradingDay, lastTradingDayCutoffMs, isMarketClosed } from '../lib/data/market-calendar';
import { parseAmtIsoInput, parseProtectivePutInput } from '../functions/_lib/calc-parsers';
import { volsArtifact, cutoffSeconds } from './helpers/live-vols-fixture';
import { TICKER_ALIASES, getTrailingReturn, isKnownTicker } from '../lib/data/trailing-returns';
import golden from './fixtures/vols-artifact-v1.json';
import { stubFetch, jsonResponse } from './helpers/stub-fetch';

const DAY = 86_400;

// A Wednesday: an ordinary mid-week trading day with a Tuesday before it.
const WEDNESDAY = new Date('2026-08-19T14:00:00Z');

beforeEach(() => {
  __setVolSnapshotForTests(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __setVolSnapshotForTests(undefined);
});

describe('lastTradingDay — weekends', () => {
  it('is strictly before today, matching the producer definition', () => {
    // Wednesday -> Tuesday. Never "today", even though Wednesday is open:
    // the artifact carries the PREVIOUS session's close until today settles.
    expect(lastTradingDay(new Date('2026-08-19T00:00:00Z'))).toBe('2026-08-18');
    expect(lastTradingDay(new Date('2026-08-19T23:59:59Z'))).toBe('2026-08-18');
  });

  it('skips back over the weekend on a Monday', () => {
    // 2026-08-24 is a Monday; the previous session is Friday the 21st.
    expect(lastTradingDay(new Date('2026-08-24T12:00:00Z'))).toBe('2026-08-21');
  });

  it('reports Friday from Saturday and Sunday too', () => {
    expect(lastTradingDay(new Date('2026-08-22T12:00:00Z'))).toBe('2026-08-21'); // Sat
    expect(lastTradingDay(new Date('2026-08-23T12:00:00Z'))).toBe('2026-08-21'); // Sun
  });
});

describe('lastTradingDay — US market holidays', () => {
  it('skips Thanksgiving (floating: 4th Thursday of November)', () => {
    // Thanksgiving 2026 is Thursday Nov 26. On Friday the 27th the last close
    // is Wednesday the 25th, NOT the closed Thursday.
    expect(lastTradingDay(new Date('2026-11-27T12:00:00Z'))).toBe('2026-11-25');
  });

  it('skips Christmas and lands on the preceding session', () => {
    // Christmas 2026 is a Friday; Saturday the 26th looks back past it.
    expect(lastTradingDay(new Date('2026-12-26T12:00:00Z'))).toBe('2026-12-24');
  });

  it('skips Good Friday (Easter-derived, not a fixed date)', () => {
    // Easter 2026 is April 5, so Good Friday is April 3. The following
    // Monday, April 6, looks back to Thursday April 2.
    expect(lastTradingDay(new Date('2026-04-06T12:00:00Z'))).toBe('2026-04-02');
    expect(isMarketClosed(new Date('2026-04-03T00:00:00Z'))).toBe(true);
  });

  it('skips a holiday-plus-weekend run (July 4 observed on a Friday)', () => {
    // July 4 2026 is a Saturday, observed Friday July 3. Monday July 6 must
    // look back to Thursday July 2.
    expect(lastTradingDay(new Date('2026-07-06T12:00:00Z'))).toBe('2026-07-02');
  });

  it('does not close on December 31 for a Saturday New Year (the NYSE exception)', () => {
    // Jan 1 2028 is a Saturday. Friday Dec 31 2027 stays a trading day, so
    // Monday Jan 3 2028 looks back to it.
    expect(isMarketClosed(new Date('2027-12-31T00:00:00Z'))).toBe(false);
    expect(lastTradingDay(new Date('2028-01-03T12:00:00Z'))).toBe('2027-12-31');
  });

  it('observes a Sunday New Year on the following Monday', () => {
    // Jan 1 2028... is Saturday; 2033-01-01 is a Saturday too. 2023-01-01 was
    // a Sunday, observed Monday Jan 2. Tuesday Jan 3 2023 looks back to
    // Friday Dec 30 2022.
    expect(isMarketClosed(new Date('2023-01-02T00:00:00Z'))).toBe(true);
    expect(lastTradingDay(new Date('2023-01-03T12:00:00Z'))).toBe('2022-12-30');
  });
});

describe('the freshness gate', () => {
  it('accepts an entry stamped exactly at the cutoff', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY)));
    expect(getLiveVol('NVDA', WEDNESDAY)).toBe(0.4447);
  });

  it('accepts an entry stamped after the cutoff (today\'s own close)', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY) + DAY));
    expect(getLiveVol('NVDA', WEDNESDAY)).toBe(0.4447);
  });

  it('REJECTS an entry one second before the cutoff', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY) - 1));
    expect(getLiveVol('NVDA', WEDNESDAY)).toBeNull();
  });

  it('REJECTS a snapshot a few days stale — the bug this replaces', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY) - 4 * DAY));
    expect(getLiveVol('NVDA', WEDNESDAY)).toBeNull();
  });

  it('gates per ticker: one stale entry does not blank a fresh neighbour', () => {
    const fresh = cutoffSeconds(WEDNESDAY);
    __setVolSnapshotForTests({
      schemaV: 1,
      vols: {
        NVDA: { atmIV1y: 0.44, asOf: fresh },
        AAPL: { atmIV1y: 0.27, asOf: fresh - 30 * DAY },
      },
    });
    expect(getLiveVol('NVDA', WEDNESDAY)).toBe(0.44);
    expect(getLiveVol('AAPL', WEDNESDAY)).toBeNull();
  });

  it('rejects the whole document when schemaV is not 1', () => {
    const doc = volsArtifact(cutoffSeconds(WEDNESDAY));
    __setVolSnapshotForTests({ ...doc, schemaV: 2 });
    expect(getLiveVol('NVDA', WEDNESDAY)).toBeNull();
  });

  it('returns null for a ticker the artifact does not carry', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY)));
    expect(getLiveVol('BOGUS', WEDNESDAY)).toBeNull();
  });

  it('resolves the GOOG share-class alias to GOOGL', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY)));
    expect(getLiveVol('goog', WEDNESDAY)).toBe(getLiveVol('GOOGL', WEDNESDAY));
    expect(getLiveVol('GOOG', WEDNESDAY)).toBe(0.3222);
  });

  it('rejects entries with a missing, non-numeric or out-of-range IV', () => {
    const asOf = cutoffSeconds(WEDNESDAY);
    __setVolSnapshotForTests({
      schemaV: 1,
      vols: {
        A: { atmIV1y: 0, asOf },
        B: { atmIV1y: 9, asOf },
        C: { atmIV1y: Number.NaN, asOf },
        D: { atmIV1y: '0.3' as unknown as number, asOf },
        E: { atmIV1y: 0.3, asOf: 'yesterday' as unknown as number },
      },
    });
    for (const t of ['A', 'B', 'C', 'D', 'E']) expect(getLiveVol(t, WEDNESDAY)).toBeNull();
  });

  it('resolves nothing at all when the memo was never warmed', () => {
    expect(getLiveVol('NVDA', WEDNESDAY)).toBeNull();
  });
});

describe('warmVolSnapshot — fetching', () => {
  it('requests the frozen artifact URL under a short timeout', async () => {
    const spy = stubFetch(() => jsonResponse(volsArtifact(cutoffSeconds())));
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(VOLS_URL);
    expect(VOLS_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    expect(getLiveVol('NVDA')).toBe(0.4447);
  });

  it('memoizes: a burst of warms issues ONE fetch', async () => {
    const spy = stubFetch(() => jsonResponse(volsArtifact(cutoffSeconds())));
    await Promise.all([warmVolSnapshot(), warmVolSnapshot(), warmVolSnapshot()]);
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refetches once the memo TTL has elapsed, not before', async () => {
    vi.useFakeTimers();
    const spy = stubFetch(() => jsonResponse(volsArtifact(cutoffSeconds())));
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + VOLS_MEMO_TTL_MS - 1_000);
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(1); // still inside the TTL

    vi.setSystemTime(Date.now() + 2_000);
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(2); // past it
  });

  it('memoizes a FAILURE too, so an outage is not re-paid on every call', async () => {
    const spy = stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    await warmVolSnapshot();
    await warmVolSnapshot();
    // VOLS_FETCH_ATTEMPTS for the FIRST warm (the bounded retry), then zero for
    // the second: the point is that the memoized failure stops the second warm
    // from paying anything at all, not that the first tried only once.
    expect(spy).toHaveBeenCalledTimes(VOLS_FETCH_ATTEMPTS);
    expect(getLiveVol('NVDA')).toBeNull();
  });

  // ── The bounded retry ───────────────────────────────────────────────────
  // A single transient blip used to memoize failure for the whole 5-minute
  // TTL: one 502 blanked `ticker` volatility for every caller for five
  // minutes. Two attempts, a short fixed backoff, one hard overall budget.
  it('retries a transient failure and populates the memo on the second attempt', async () => {
    let calls = 0;
    const spy = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'bad gateway' }, 502)
        : jsonResponse(volsArtifact(cutoffSeconds()));
    });
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(getLiveVol('NVDA')).toBe(0.4447);
  });

  it('retries a transport error too, not just a bad status', async () => {
    let calls = 0;
    const spy = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new DOMException('timed out', 'TimeoutError'))
        : Promise.resolve(jsonResponse(volsArtifact(cutoffSeconds())));
    });
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(getLiveVol('NVDA')).toBe(0.4447);
  });

  it('gives up after VOLS_FETCH_ATTEMPTS and memoizes null when both fail', async () => {
    const spy = stubFetch(() => jsonResponse({ error: 'bad gateway' }, 502));
    await warmVolSnapshot();
    expect(spy).toHaveBeenCalledTimes(VOLS_FETCH_ATTEMPTS);
    expect(getLiveVol('NVDA')).toBeNull();
  });

  it('does NOT retry a definitive answer: 404, or a 200 that fails the schema', async () => {
    const missing = stubFetch(() => jsonResponse({ error: 'not found' }, 404));
    await warmVolSnapshot();
    expect(missing).toHaveBeenCalledTimes(1);

    __setVolSnapshotForTests(undefined);
    const wrongSchema = stubFetch(() => jsonResponse({ schemaV: 2, vols: {} }));
    await warmVolSnapshot();
    expect(wrongSchema).toHaveBeenCalledTimes(1);
    expect(getLiveVol('NVDA')).toBeNull();
  });

  it('bounds the whole warm, retry included, by VOLS_TOTAL_BUDGET_MS', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const started = Date.now();
    await warmVolSnapshot();
    expect(Date.now() - started).toBeLessThanOrEqual(VOLS_TOTAL_BUDGET_MS + 500);
  });

  it('never throws, whatever the transport does', async () => {
    stubFetch(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    await expect(warmVolSnapshot()).resolves.toBeUndefined();
    expect(getLiveVol('NVDA')).toBeNull();
  });

  it('resolves nothing on a non-200', async () => {
    stubFetch(() => jsonResponse({ error: 'nope' }, 500));
    await warmVolSnapshot();
    expect(getLiveVol('NVDA')).toBeNull();
  });

  it('resolves nothing on a body that is not JSON', async () => {
    stubFetch(() => new Response('<!doctype html>', { status: 200 }));
    await warmVolSnapshot();
    expect(getLiveVol('NVDA')).toBeNull();
  });

  it('resolves nothing when the document has the wrong schemaV', async () => {
    stubFetch(() => jsonResponse({ ...volsArtifact(cutoffSeconds()), schemaV: 2 }));
    await warmVolSnapshot();
    expect(getLiveVol('NVDA')).toBeNull();
  });

  it('resolves nothing when `vols` is missing or not an object', async () => {
    stubFetch(() => jsonResponse({ schemaV: 1, vols: [] }));
    await warmVolSnapshot();
    expect(getLiveVol('NVDA')).toBeNull();
  });
});

// The whole point: every failure mode lands on the SAME error an uncovered
// ticker has always produced, at the same call sites, with the same wording.
describe('failure degrades to the existing required-field error', () => {
  const AMT_NO_VOL = {
    shares: 5000,
    strike: 4,
    fmv: 90,
    expectedGrowth: 0.17,
    filingStatus: 'single',
    ordinaryIncome: 250000,
    stateCode: 'CA',
    horizon: 4,
    grantDate: '2024-05-20',
    hasLeftCompany: false,
    terminationDate: null,
    ticker: 'NVDA',
  };
  const PUT = { positionValue: 100000, sector: 'tech_software', protectionLevel: 0.2, tenorYears: 1 };

  it('404 from the producer: the drag tools raise "field volatility required"', async () => {
    // This is the pre-deploy state of the world — the artifact does not exist
    // yet. It must behave exactly like an uncovered ticker, which is what
    // makes this change safe to ship before the producer does.
    stubFetch(() => new Response('not found', { status: 404 }));
    await warmVolSnapshot();
    expect(() => parseAmtIsoInput(AMT_NO_VOL)).toThrow(
      /field "volatility" required.*NVDA.*MUST NOT invent/is,
    );
  });

  it('404 from the producer: protective_put keeps its documented sector default', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    await warmVolSnapshot();
    const out = parseProtectivePutInput({ ...PUT, ticker: 'NVDA' });
    // Unchanged behaviour for THIS tool: an unresolvable ticker has always
    // fallen back to sector-typical IV here, and its description says so.
    expect(out.volatility).toBeGreaterThan(0);
    expect(out.volatility).not.toBe(0.4447);
  });

  it('a stale artifact raises the same error as a missing one', async () => {
    stubFetch(() => jsonResponse(volsArtifact(cutoffSeconds() - 30 * DAY)));
    await warmVolSnapshot();
    expect(() => parseAmtIsoInput(AMT_NO_VOL)).toThrow(/field "volatility" required/);
  });

  it('a fresh artifact resolves the sigma instead of erroring', async () => {
    stubFetch(() => jsonResponse(volsArtifact(cutoffSeconds())));
    await warmVolSnapshot();
    expect(() => parseAmtIsoInput(AMT_NO_VOL)).not.toThrow();
    expect(parseProtectivePutInput({ ...PUT, ticker: 'NVDA' }).volatility).toBe(0.4447);
  });

  it('explicit volatility still wins over everything', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    await warmVolSnapshot();
    expect(() => parseAmtIsoInput({ ...AMT_NO_VOL, volatility: 0.42 })).not.toThrow();
  });
});

// ── The cross-repo golden ────────────────────────────────────────────────
// tests/fixtures/vols-artifact-v1.json is the frozen v1 document, pinned from
// BOTH sides: the producer (optionsahoy_web workers) asserts it writes this
// shape, this file asserts the reader accepts it. Two repos, two release
// cadences, one contract - the only way a producer change that would blank
// every `ticker` volatility fails somewhere other than production.
//
// asArtifact is module-private on purpose, so it is exercised the way
// production reaches it: served over a stubbed fetch, through warmVolSnapshot.
describe('contract v1 golden fixture', () => {
  // Fixed timestamps in the fixture + an injected clock: the golden must not
  // rot, and must keep exercising both sides of the gate forever.
  const AS_OF_DAY = new Date('2026-08-19T14:00:00Z');

  it('the reader accepts the producer document and resolves its FRESH entry', async () => {
    stubFetch(() => jsonResponse(golden));
    await warmVolSnapshot();
    expect(getLiveVol('NVDA', AS_OF_DAY)).toBe(golden.vols.NVDA.atmIV1y);
  });

  it('the same document\'s STALE entry resolves nothing', async () => {
    stubFetch(() => jsonResponse(golden));
    await warmVolSnapshot();
    // Same document, same fetch, same schema: only `asOf` differs. This is the
    // per-ENTRY gate, which is why the artifact's own generatedAt cannot be
    // what freshness is judged on.
    expect(golden.vols.AAPL.asOf).toBeLessThan(golden.vols.NVDA.asOf);
    expect(getLiveVol('AAPL', AS_OF_DAY)).toBeNull();
  });

  it('carries the fields the reader deliberately does not model', () => {
    // If the producer ever drops these, nothing here breaks - that is the
    // point of not modelling them. Asserted so the golden keeps documenting
    // the full wire shape rather than drifting into the reader's subset.
    expect(typeof golden.generatedAt).toBe('string');
    expect(golden.vols.NVDA.sourceCell).toBeDefined();
  });

  it('is exactly schemaV 1 with two entries', () => {
    expect(golden.schemaV).toBe(1);
    expect(Object.keys(golden.vols)).toEqual(['NVDA', 'AAPL']);
  });
});

// ── One alias map, two resolvers ─────────────────────────────────────────
// `ticker` is a SINGLE user-facing field that feeds two lookups (trailing
// growth, live vol). The GOOG -> GOOGL alias used to be declared twice, once
// per reader, which meant the day either list grew the two shortcuts would
// start accepting different symbols behind one field name.
describe('share-class aliases are single-sourced', () => {
  it('both resolvers accept the same alias set', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY)));
    for (const [alias, canonical] of Object.entries(TICKER_ALIASES)) {
      expect(getLiveVol(alias, WEDNESDAY)).toBe(getLiveVol(canonical, WEDNESDAY));
      expect(getTrailingReturn(alias, 3)).toBe(getTrailingReturn(canonical, 3));
      expect(isKnownTicker(alias)).toBe(isKnownTicker(canonical));
    }
    expect(Object.keys(TICKER_ALIASES).length).toBeGreaterThan(0);
  });

  it('the vol reader case-folds aliases exactly as the growth reader does', () => {
    __setVolSnapshotForTests(volsArtifact(cutoffSeconds(WEDNESDAY)));
    expect(getLiveVol('goog', WEDNESDAY)).toBe(getLiveVol('GOOGL', WEDNESDAY));
    expect(getTrailingReturn('goog', 3)).toBe(getTrailingReturn('GOOGL', 3));
  });
});

// ── Operability: pointing the reader somewhere else ──────────────────────
// The URL used to be a hardcoded literal, so a staging or preview deployment
// had no way to read a staging artifact - it silently read production, or (if
// production was fine and staging broken) looked healthy while testing
// nothing. NEXT_PUBLIC_OA_DATA_BASE is the SAME knob lib/data/chains.ts reads
// for its DATA_BASE, deliberately: one override moves every reader of the R2
// root at once, instead of half of them.
describe('VOLS_URL base is env-overridable', () => {
  it('defaults to the public R2 root, byte-identical to the old literal', () => {
    expect(VOLS_URL).toBe('https://data.optionsahoy.com/chains/vols.json');
  });

  it('follows NEXT_PUBLIC_OA_DATA_BASE when set', async () => {
    const prev = process.env.NEXT_PUBLIC_OA_DATA_BASE;
    vi.resetModules();
    process.env.NEXT_PUBLIC_OA_DATA_BASE = 'https://staging-data.example.com';
    try {
      const staged = await import('../lib/data/live-vols');
      expect(staged.VOLS_URL).toBe('https://staging-data.example.com/chains/vols.json');
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_OA_DATA_BASE;
      else process.env.NEXT_PUBLIC_OA_DATA_BASE = prev;
      vi.resetModules();
    }
  });
});

describe('cutoff arithmetic', () => {
  it('lastTradingDayCutoffMs is midnight UTC of lastTradingDay', () => {
    const cutoff = lastTradingDayCutoffMs(WEDNESDAY);
    expect(new Date(cutoff).toISOString()).toBe(`${lastTradingDay(WEDNESDAY)}T00:00:00.000Z`);
  });
});
