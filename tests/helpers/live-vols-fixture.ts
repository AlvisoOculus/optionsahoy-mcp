// AlphaLatitude Inc. © 2026
//
// Shared fixture for the published implied-vol artifact. Every test that
// exercises ticker -> sigma resolution seeds the reader from HERE rather than
// from the network: the producer publishes on its own schedule and may not be
// deployed at all, so a suite that reached for the live URL would be a flake
// generator and would go red the day a symbol left the chain universe.

import { __setVolSnapshotForTests, type VolsArtifact } from '../../lib/data/live-vols';
import { lastTradingDayCutoffMs } from '../../lib/data/market-calendar';

/** Sigmas the fixture publishes. Values are arbitrary but distinct, so a test
 *  asserting "AAPL's sigma was used" cannot pass on MSFT's by coincidence. */
export const FIXTURE_VOLS: Record<string, number> = {
  NVDA: 0.4447,
  AAPL: 0.2731,
  MSFT: 0.2419,
  GOOGL: 0.3222,
  SPY: 0.1608,
};

/** Epoch SECONDS at the last-trading-day cutoff: the oldest `asOf` the gate
 *  still accepts. Anything below this is stale by definition. */
export function cutoffSeconds(now: Date = new Date()): number {
  return Math.floor(lastTradingDayCutoffMs(now) / 1000);
}

/** Build a v1 artifact whose every entry carries `asOf`. */
export function volsArtifact(asOf: number, vols: Record<string, number> = FIXTURE_VOLS): VolsArtifact {
  return {
    schemaV: 1,
    generatedAt: new Date(asOf * 1000).toISOString(),
    vols: Object.fromEntries(
      Object.entries(vols).map(([t, atmIV1y]) => [t, { atmIV1y, asOf, sourceCell: {} }]),
    ),
  };
}

/** Seed the reader with a fresh artifact (asOf exactly at the cutoff, the
 *  oldest value the gate accepts, so the boundary is exercised by every test
 *  that merely wants "a covered ticker"). */
export function seedFreshVols(vols: Record<string, number> = FIXTURE_VOLS, now: Date = new Date()): void {
  __setVolSnapshotForTests(volsArtifact(cutoffSeconds(now), vols));
}

/** Reset the reader to cold — no artifact, as if nothing had warmed it. */
export function clearVols(): void {
  __setVolSnapshotForTests(undefined);
}
