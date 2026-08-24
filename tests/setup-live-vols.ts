// AlphaLatitude Inc. © 2026
//
// Global test setup: seed the published implied-vol artifact before EVERY
// test, in every file.
//
// Two reasons this is a root hook rather than a per-file import:
//
// 1. Hermeticity. Request handlers now call warmVolSnapshot(), which fetches
//    https://data.optionsahoy.com/chains/vols.json. A pre-seeded memo is
//    inside its TTL, so the warm returns immediately and NO test ever reaches
//    the network — the suite is green whether the producer is deployed, down,
//    or serving something new, and CI does not pay a timeout per test.
// 2. It preserves the pre-change baseline. Under the old baked table any
//    covered ticker always resolved a sigma, so the tool-level tests (poe,
//    session dedup, widget) could pass `ticker` and expect a full answer.
//    Seeding a fresh fixture keeps exactly that meaning: "this ticker is
//    covered and current".
//
// Tests that care about the GATE itself (tests/live-vols.test.ts) clear or
// replace this in their own beforeEach, which runs after this one.

import { beforeEach } from 'vitest';
import { seedFreshVols } from './helpers/live-vols-fixture';

beforeEach(() => {
  seedFreshVols();
});
