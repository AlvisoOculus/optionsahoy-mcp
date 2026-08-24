// AlphaLatitude Inc. © 2026
//
// Shared fixture for the per-ticker option chain reader. Same rule as the
// vols fixture next door: every test that exercises chain pricing seeds it
// from HERE, never from the network. The chain worker serves live market data
// that changes every session, so a suite reaching for the live URL would
// assert on numbers that move under it.
//
// The fixture itself is a REAL chain, captured from
// https://data.optionsahoy.com/chains/fetch/NVDA on 2026-08-24 and committed
// as tests/fixtures/chain-nvda-v3.json. Real because the thing under test is
// an interpolation over a real surface's shape: a hand-built grid would have
// whatever skew the author drew into it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { __setChainsForTests } from '../../lib/data/live-chain';
import type { TickerChain } from '../../lib/data/chains';
import { cutoffSeconds } from './live-vols-fixture';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'chain-nvda-v3.json',
);

/** The capture date. Pin `today` to this in any test whose expected numbers
 *  were computed from the fixture's tenors, so an expiration drifting one day
 *  closer does not move them. */
export const FIXTURE_CAPTURE_DATE = new Date('2026-08-24T00:00:00Z');

/** The committed chain, verbatim. Fresh copy per call: callers mutate it (to
 *  break the schema, to age it out) and must not disturb each other. */
export function nvdaChain(): TickerChain {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as TickerChain;
}

/** Epoch SECONDS at the last-trading-day cutoff: the oldest `asOf` the
 *  freshness gate still accepts. One definition for both readers - they share
 *  the gate (lib/data/market-calendar isAsOfFresh), so their fixtures must
 *  share the boundary or one of them would be testing a different edge. */
export { cutoffSeconds };

/** The committed chain restamped as of the cutoff, which is the OLDEST asOf
 *  the gate accepts - so every test that merely wants "a current chain" also
 *  exercises the boundary. Restamping is what stops the suite from going red
 *  the day after the capture. */
export function freshNvdaChain(now: Date = new Date()): TickerChain {
  return { ...nvdaChain(), asOf: cutoffSeconds(now) };
}

/** Seed a current NVDA chain and nothing else: any other symbol resolves
 *  nothing and prices flat. Tests that want a different chain (stale, wrong
 *  schema, remembered failure) call __setChainsForTests directly, which reads
 *  better at the point of use than a fixture argument. */
export function seedFreshChain(): void {
  __setChainsForTests({ NVDA: freshNvdaChain() });
}

/** Empty the memo: every ticker prices flat. The default state for the whole
 *  suite (tests/setup-market-data.ts). */
export function seedNoChains(): void {
  __setChainsForTests({});
}
