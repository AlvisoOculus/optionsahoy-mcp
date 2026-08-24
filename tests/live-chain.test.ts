// AlphaLatitude Inc. © 2026
//
// The per-ticker chain reader and its read-time gates.
//
// The contract this file pins down: a chain either resolves AS OF THE LAST
// MARKET CLOSE, or resolves NOTHING and protective_put_price prices flat and
// says so. There is no third outcome, and in particular no "close enough"
// chain: the endpoint can serve a deliberately stale body when its upstream
// budget is spent, and that body arrives as a healthy 200.
//
// Everything here is fixture-driven. `fetch` is stubbed per test, so the suite
// is green whether or not the chains worker is reachable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubFetch, jsonResponse } from './helpers/stub-fetch';
import {
  CHAIN_FETCH_TIMEOUT_MS,
  CHAIN_MEMO_TTL_MS,
  CHAIN_MEMO_MAX_ENTRIES,
  CHAIN_SCHEMA_V,
  chainUrl,
  getLiveChain,
  warmChain,
  __setChainsForTests,
} from '../lib/data/live-chain';
import { TICKER_CHAIN_SCHEMA_V, type TickerChain } from '../lib/data/chains';
import { lastTradingDayCutoffMs } from '../lib/data/market-calendar';
import { nvdaChain, cutoffSeconds, freshNvdaChain, seedNoChains } from './helpers/live-chain-fixture';

const DAY = 86_400;

// A Wednesday: an ordinary mid-week trading day with a Tuesday before it.
const WEDNESDAY = new Date('2026-08-19T14:00:00Z');

// These tests exercise the fetch path itself, so each stubs its own fetch over
// the suite-wide block (tests/setup-market-data.ts) and starts from an empty
// memo.
beforeEach(() => {
  seedNoChains();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  seedNoChains();
});

describe('the schema gate', () => {
  it('accepts the schema version the worker writes', () => {
    expect(CHAIN_SCHEMA_V).toBe(TICKER_CHAIN_SCHEMA_V);
    expect(CHAIN_SCHEMA_V).toBe(3);
  });

  it('refuses a document at any other version, at read time as well as fetch time', () => {
    // Seeded straight into the memo, which is the path a future filler could
    // take without passing the fetch-side check.
    __setChainsForTests({ NVDA: { ...nvdaChain(), asOf: cutoffSeconds(WEDNESDAY), schemaV: 4 } });
    expect(getLiveChain('NVDA', WEDNESDAY)).toBeNull();
  });

  it('refuses a 200 whose body is not a chain', async () => {
    for (const body of [null, 42, 'nope', {}, { schemaV: 3 }, { schemaV: 3, ticker: 'NVDA' }]) {
      seedNoChains();
      stubFetch(() => jsonResponse(body));
      await warmChain('NVDA');
      expect(getLiveChain('NVDA', WEDNESDAY), JSON.stringify(body)).toBeNull();
    }
  });

  it('refuses a chain whose sides are not parallel arrays', async () => {
    const broken = nvdaChain();
    broken.puts.k = broken.puts.k.slice(0, 3);
    stubFetch(() => jsonResponse({ ...broken, asOf: cutoffSeconds() }));
    await warmChain('NVDA');
    // A short parallel array does not throw, it reads undefined and yields NaN
    // sigmas - which is why the length check is here and not left to the
    // interpolator to survive.
    expect(getLiveChain('NVDA')).toBeNull();
  });

  it('refuses a body for a DIFFERENT symbol than the one requested', async () => {
    stubFetch(() => jsonResponse({ ...nvdaChain(), ticker: 'AMD', asOf: cutoffSeconds() }));
    await warmChain('NVDA');
    expect(getLiveChain('NVDA')).toBeNull();
  });
});

describe('the freshness gate', () => {
  it('accepts a chain stamped exactly at the last-close cutoff', () => {
    __setChainsForTests({ NVDA: { ...nvdaChain(), asOf: cutoffSeconds(WEDNESDAY) } });
    expect(getLiveChain('NVDA', WEDNESDAY)).not.toBeNull();
  });

  it('REFUSES a chain one second older than the cutoff', () => {
    // This is the budget-exhausted stale serve. It is a healthy 200 carrying a
    // well-formed chain; only its asOf gives it away.
    __setChainsForTests({ NVDA: { ...nvdaChain(), asOf: cutoffSeconds(WEDNESDAY) - 1 } });
    expect(getLiveChain('NVDA', WEDNESDAY)).toBeNull();
  });

  it('refuses a chain from the previous week', () => {
    __setChainsForTests({ NVDA: { ...nvdaChain(), asOf: cutoffSeconds(WEDNESDAY) - 7 * DAY } });
    expect(getLiveChain('NVDA', WEDNESDAY)).toBeNull();
  });

  it('uses the same cutoff definition as the vols reader', () => {
    // Both gates are "as of the last trading day's close or newer", off one
    // calendar. Stated here so a change to one is visibly a change to both.
    expect(cutoffSeconds(WEDNESDAY) * 1000).toBe(lastTradingDayCutoffMs(WEDNESDAY));
  });

  it('refuses a chain with no usable asOf or spot', () => {
    const cases: Array<Partial<TickerChain>> = [
      { asOf: undefined as unknown as number },
      { asOf: NaN },
      { asOf: 'yesterday' as unknown as number },
      { spot: 0 },
      { spot: -5 },
      { spot: undefined as unknown as number },
    ];
    for (const patch of cases) {
      __setChainsForTests({ NVDA: { ...freshNvdaChain(WEDNESDAY), ...patch } });
      expect(getLiveChain('NVDA', WEDNESDAY), JSON.stringify(patch)).toBeNull();
    }
  });

  it('resolves nothing at all when the memo was never warmed', () => {
    __setChainsForTests({});
    expect(getLiveChain('NVDA', WEDNESDAY)).toBeNull();
  });
});

describe('warmChain - fetching', () => {
  it('requests the on-demand endpoint for that ticker, under a short timeout', async () => {
    const spy = stubFetch(() => jsonResponse(freshNvdaChain()));
    await warmChain('NVDA');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('https://data.optionsahoy.com/chains/fetch/NVDA');
    expect(chainUrl('NVDA')).toBe('https://data.optionsahoy.com/chains/fetch/NVDA');
    expect(CHAIN_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(4_000);
    expect(getLiveChain('NVDA')!.spot).toBe(214.72);
  });

  it('canonicalizes the symbol before it reaches the URL', async () => {
    const spy = stubFetch(() => jsonResponse({ ...freshNvdaChain(), ticker: 'NVDA' }));
    await warmChain(' nvda ');
    expect(spy.mock.calls[0][0]).toBe('https://data.optionsahoy.com/chains/fetch/NVDA');
    expect(getLiveChain('nvda')).not.toBeNull();
  });

  it('never puts a caller-shaped string in the URL path', async () => {
    const spy = stubFetch(() => jsonResponse(freshNvdaChain()));
    for (const junk of ['../../etc/passwd', 'NVDA/../AMD', 'a b', '', 'WAYTOOLONGSYMBOL', 'x?y=1']) {
      await warmChain(junk);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('memoizes: a burst of warms for one ticker issues ONE fetch', async () => {
    const spy = stubFetch(() => jsonResponse(freshNvdaChain()));
    await Promise.all([warmChain('NVDA'), warmChain('NVDA'), warmChain('NVDA')]);
    await warmChain('NVDA');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('memoizes PER TICKER, not globally', async () => {
    const spy = stubFetch((url) =>
      jsonResponse({ ...freshNvdaChain(), ticker: String(url).split('/').pop() }),
    );
    await warmChain('NVDA');
    await warmChain('AAPL');
    await warmChain('NVDA');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetches once the memo TTL has elapsed, not before', async () => {
    vi.useFakeTimers();
    const spy = stubFetch(() => jsonResponse(freshNvdaChain()));
    await warmChain('NVDA');
    expect(spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + CHAIN_MEMO_TTL_MS - 1_000);
    await warmChain('NVDA');
    expect(spy).toHaveBeenCalledTimes(1); // still inside the TTL

    vi.setSystemTime(Date.now() + 2_000);
    await warmChain('NVDA');
    expect(spy).toHaveBeenCalledTimes(2); // past it
  });

  it('memoizes a FAILURE too, so an outage is not re-paid on every call', async () => {
    const spy = stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    await warmChain('NVDA');
    await warmChain('NVDA');
    // One attempt, then nothing: this reader does not retry, because its caller
    // has a good degraded mode (flat pricing) and a 429 here means the origin
    // just told us it is out of budget.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getLiveChain('NVDA')).toBeNull();
  });

  it('treats a 429 (upstream budget spent) as no chain, not as an error', async () => {
    stubFetch(() => new Response('rate limited', { status: 429 }));
    await expect(warmChain('NVDA')).resolves.toBeUndefined();
    expect(getLiveChain('NVDA')).toBeNull();
  });

  it('never throws, whatever the transport does', async () => {
    for (const impl of [
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      () => new Response('<html>502</html>', { status: 502 }),
      () => new Response('not json', { status: 200 }),
      () => {
        throw new Error('sync explosion');
      },
    ]) {
      seedNoChains();
      stubFetch(impl as never);
      await expect(warmChain('NVDA')).resolves.toBeUndefined();
      expect(getLiveChain('NVDA')).toBeNull();
    }
  });

  it('bounds the memo, so a long-lived stdio process cannot grow without limit', async () => {
    const spy = stubFetch((url) =>
      jsonResponse({ ...freshNvdaChain(), ticker: String(url).split('/').pop() }),
    );
    const symbols = Array.from({ length: CHAIN_MEMO_MAX_ENTRIES + 1 }, (_, i) => `T${i}`);
    for (const s of symbols) await warmChain(s);
    expect(spy).toHaveBeenCalledTimes(symbols.length);
    // The oldest write was evicted, so it costs one refetch; the newest is
    // still memoized and costs none.
    await warmChain(symbols[symbols.length - 1]!);
    expect(spy).toHaveBeenCalledTimes(symbols.length);
    await warmChain(symbols[0]!);
    expect(spy).toHaveBeenCalledTimes(symbols.length + 1);
  });

  it('resolves nothing when nothing stubs the network, which is the suite default', async () => {
    // No stubFetch here on purpose: the suite-wide guard rejects every request,
    // and that has to land on the same memoized-failure path a real outage
    // takes. It is what makes an unseeded ticker in any other test file price
    // flat instead of quietly fetching a real chain.
    await expect(warmChain('NVDA')).resolves.toBeUndefined();
    expect(getLiveChain('NVDA')).toBeNull();
  });

  it('follows the shared DATA_BASE override, like the vols reader', async () => {
    const prev = process.env.NEXT_PUBLIC_OA_DATA_BASE;
    vi.resetModules();
    process.env.NEXT_PUBLIC_OA_DATA_BASE = 'https://staging-data.example.com';
    try {
      const staged = await import('../lib/data/live-chain');
      expect(staged.chainUrl('NVDA')).toBe('https://staging-data.example.com/chains/fetch/NVDA');
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_OA_DATA_BASE;
      else process.env.NEXT_PUBLIC_OA_DATA_BASE = prev;
      vi.resetModules();
    }
  });
});
