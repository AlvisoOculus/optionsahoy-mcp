// AlphaLatitude Inc. © 2026
//
// lib/data/trailing-returns.json is a COPY of optionsahoy_web's
// web/lib/trailing-returns.json (refreshed daily by the web ETL), and nothing
// syncs it. On 2026-09-24 the copy here was dated 2026-06-03 with 90 tickers
// while the source had 518 dated 2026-09-21. Every ticker-named growth lookup
// for the other ~430 symbols failed ("ticker TXN is not in our
// trailing-returns table"), including names whose volatility resolved fine,
// and the 90 that did resolve used four-month-old CAGRs.
//
// The sibling-mirror tests cannot catch this in CI (the web repo is not
// checked out there), so this checks the file itself: it must be recent and
// it must be the full table. When it fails, re-copy:
//   cp ../optionsahoy_web/web/lib/trailing-returns.json lib/data/trailing-returns.json

import { describe, it, expect } from 'vitest';
import data from '../lib/data/trailing-returns.json';

const MAX_AGE_DAYS = 60;
const MIN_TICKERS = 400;

describe('bundled trailing-returns table', () => {
  it(`was refreshed within the last ${MAX_AGE_DAYS} days`, () => {
    const refreshed = new Date(`${data._refreshedAt}T00:00:00Z`).getTime();
    const ageDays = (Date.now() - refreshed) / 86_400_000;
    expect(
      ageDays,
      `trailing-returns.json is ${Math.floor(ageDays)} days old (refreshed ${data._refreshedAt}); ` +
        're-copy it from optionsahoy_web/web/lib/trailing-returns.json',
    ).toBeLessThanOrEqual(MAX_AGE_DAYS);
  });

  it(`carries the full table (at least ${MIN_TICKERS} tickers)`, () => {
    expect(Object.keys(data.tickers).length).toBeGreaterThanOrEqual(MIN_TICKERS);
  });

  it('still carries SPY, which the "market" growth sentinel reads', () => {
    expect(Object.hasOwn(data.tickers, 'SPY')).toBe(true);
  });
});
