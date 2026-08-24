// AlphaLatitude Inc. © 2026
//
// Global test setup: the suite's hermeticity, in one place, run before EVERY
// test in every file.
//
// Three things, and they are one story - no test reads live market data:
//
// 1. FETCH IS GUARDED. Both published-artifact readers (lib/data/live-vols,
//    lib/data/live-chain) fetch at a request boundary, and both swallow every
//    failure by design, so a stub that always rejects is indistinguishable
//    from "the feed is unreachable": the vols memo stays empty and a chain
//    resolves nothing, which is exactly the degraded behaviour the suite
//    should see by default. A test that wants a successful fetch stubs its own
//    (tests/helpers/stub-fetch.ts) in its own beforeEach, which runs after
//    this one. This is what makes hermeticity a property of the suite rather
//    than of each author remembering.
// 2. THE VOLS ARTIFACT IS SEEDED. Under the baked table that preceded the live
//    feed, any covered ticker always resolved a sigma, and the tool-level
//    tests (poe, session dedup, widget) rely on that meaning: "this ticker is
//    covered and current". A fresh fixture preserves it.
// 3. THE CHAIN MEMO IS EMPTY. Cleared rather than seeded, so protective_put
//    _price prices flat unless a test says otherwise - the behaviour the whole
//    suite had before chain mode existed. Tests that exercise chain mode seed
//    it (tests/helpers/live-chain-fixture.ts).

import { beforeEach, vi } from 'vitest';
import { seedFreshVols } from './helpers/live-vols-fixture';
import { seedNoChains } from './helpers/live-chain-fixture';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      throw new Error(
        `network blocked in tests: ${String(url)}. Stub fetch in this test (tests/helpers/stub-fetch.ts) or seed the reader's fixture.`,
      );
    }),
  );
  seedFreshVols();
  seedNoChains();
});
