// AlphaLatitude Inc. © 2026
//
// The growth table is read live from optionsahoy.com/data/trailing-returns.json
// (published by optionsahoy_web on every deploy), with the bundled copy as the
// fallback. The bundled copy alone sat four months stale with 90 of 518
// tickers, failing growth lookups for ~430 covered symbols.

import { describe, it, expect, vi } from 'vitest';
import {
  GROWTH_URL,
  __setGrowthSnapshotForTests,
  warmGrowthSnapshot,
} from '../lib/data/live-growth';
import { getTrailingReturn, hasTrailingReturn, trailingReturnsCoverage } from '../lib/data/trailing-returns';
import { mayResolveGrowth, warmForCall } from '../functions/_lib/calc-parsers';

const ENTRY = { return5y: 0.2, return10y: 0.2, earliestSpanYears: 10, asOf: '2099-01-01' };
const doc = (refreshedAt: string) => ({ refreshedAt, tickers: { ZZZZ: ENTRY, SPY: ENTRY } });

describe('live growth table', () => {
  it('answers from the live table when it is at least as new as the bundle', () => {
    __setGrowthSnapshotForTests(doc('2099-01-01'));
    expect(hasTrailingReturn('ZZZZ')).toBe(true);
    expect(getTrailingReturn('ZZZZ', 5)).toBeCloseTo(0.2, 6);
    expect(trailingReturnsCoverage().refreshedAt).toBe('2099-01-01');
  });

  it('ignores a live table OLDER than the bundle', () => {
    __setGrowthSnapshotForTests(doc('2000-01-01'));
    expect(hasTrailingReturn('ZZZZ')).toBe(false);
    expect(hasTrailingReturn('NVDA')).toBe(true); // bundle still answers
  });

  it('falls back to the bundle when the fetch fails', async () => {
    // setup-market-data blocks fetch, so the warm records "no document".
    await warmGrowthSnapshot();
    expect(hasTrailingReturn('ZZZZ')).toBe(false);
    expect(getTrailingReturn('NVDA', 5)).not.toBeNull();
  });

  it('fetches the published URL and uses what it returns', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ _refreshedAt: '2099-01-01', tickers: { ZZZZ: ENTRY } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    await warmGrowthSnapshot();
    expect(String((spy.mock.calls[0] as unknown[])[0])).toBe(GROWTH_URL);
    expect(GROWTH_URL).toBe('https://optionsahoy.com/data/trailing-returns.json');
    expect(getTrailingReturn('ZZZZ', 5)).toBeCloseTo(0.2, 6);
  });
});

describe('mayResolveGrowth — warm only where a parser can read the table', () => {
  it.each([
    ['amt_iso_optimize', { ticker: 'TXN' }, true],
    ['amt_iso_optimize', { ticker: 'TXN', expectedGrowth: 0.1 }, false],
    ['amt_iso_optimize', { expectedGrowth: 'market' }, true],
    ['nso_calculate', { expectedSalePrice: 80, expectedMarketReturn: 0.07 }, false],
    ['nso_calculate', { expectedSalePrice: 80 }, true], // market return defaults to SPY
    ['concentration_analyze', { ticker: 'AXON', expectedMarketReturn: 0.07 }, true],
    ['equity_funding_plan', { stacks: [{ ticker: 'ZBRA' }] }, true],
    ['qsbs_check', { ticker: 'NVDA' }, false],
    ['protective_put_price', { ticker: 'NVDA' }, false],
  ])('%s %j -> %s', (tool, args, expected) => {
    expect(mayResolveGrowth(tool, args)).toBe(expected);
  });

  it('warmForCall fetches the growth table for a ticker-named growth call', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', spy);
    await warmForCall('amt_iso_optimize', { ticker: 'TXN', volatility: 0.4 });
    expect(spy.mock.calls.map((c) => String((c as unknown[])[0]))).toContain(GROWTH_URL);
  });
});
