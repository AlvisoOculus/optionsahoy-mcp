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
  getLiveVol,
  hasLiveVol,
  warmVolSnapshot,
  __setVolSnapshotForTests,
} from '../lib/data/live-vols';
import { lastTradingDay, lastTradingDayCutoffMs, isMarketClosed } from '../lib/data/market-calendar';
import { parseAmtIsoInput, parseProtectivePutInput } from '../functions/_lib/calc-parsers';
import { volsArtifact, cutoffSeconds } from './helpers/live-vols-fixture';

const DAY = 86_400;

// A Wednesday: an ordinary mid-week trading day with a Tuesday before it.
const WEDNESDAY = new Date('2026-08-19T14:00:00Z');

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl as never);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    expect(hasLiveVol('NVDA', WEDNESDAY)).toBe(true);
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
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getLiveVol('NVDA')).toBeNull();
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

describe('cutoff arithmetic', () => {
  it('lastTradingDayCutoffMs is midnight UTC of lastTradingDay', () => {
    const cutoff = lastTradingDayCutoffMs(WEDNESDAY);
    expect(new Date(cutoff).toISOString()).toBe(`${lastTradingDay(WEDNESDAY)}T00:00:00.000Z`);
  });
});
