// AlphaLatitude Inc. © 2026
//
// Drift guard for the ticker-coverage partition and the covered-tickers MCP
// resource generated from it. The counts are intentionally NOT hardcoded: the
// bundled trailing-returns snapshot refreshes from the ETL, so the exact
// numbers move by a symbol or two between deploys. These assert the partition
// is internally consistent, that it agrees with the reader the parsers
// actually use (hasTrailingReturn), and that the resource body's stated
// numbers are recomputed from the same source rather than a stale literal.
//
// Volatility deliberately has no partition to guard any more: it resolves per
// call from the published artifact under a last-close freshness gate, so there
// is no roster to drift. The resource's vol section describes that mechanism,
// and the tests below assert it does not slip back into promising a list.

import { describe, it, expect } from 'vitest';
import { tickerCoverage } from '../lib/data/ticker-coverage';
import { RESOURCES } from '../functions/_lib/mcp-resources';

const cov = tickerCoverage();
const resource = RESOURCES.find((r) => r.uri === 'https://optionsahoy.com/tools/covered-tickers');

// tickerCoverage() partitions by calling hasTrailingReturn directly, so an
// "every listed symbol really resolves growth" test would be a tautology.
// These assert the structural properties that reuse does NOT make free:
// disjointness, sortedness, a real (non-empty) snapshot, and that the resource
// body's numbers are recomputed from the partition rather than stale.
describe('tickerCoverage partition', () => {
  it('buckets are disjoint (no symbol double-counted)', () => {
    const all = [...cov.growth, ...cov.noGrowth];
    expect(new Set(all).size).toBe(all.length);
  });

  it('sorts each bucket and includes SPY as a fully-covered index proxy', () => {
    for (const b of [cov.growth, cov.noGrowth]) {
      expect(b).toEqual([...b].sort());
    }
    expect(cov.growth).toContain('SPY'); // the canonical smoke case
  });

  it('has real coverage (guards against an empty/broken snapshot import)', () => {
    expect(cov.growth.length).toBeGreaterThan(40);
  });
});

describe('covered-tickers resource', () => {
  it('is registered with the tools/ URI and markdown mime type', () => {
    expect(resource).toBeDefined();
    expect(resource!.uri).toMatch(/^https:\/\/optionsahoy\.com\/tools\//);
    expect(resource!.mimeType).toBe('text/markdown');
    expect(resource!.description.length).toBeGreaterThan(20);
  });

  it('states the growth count recomputed from tickerCoverage, not a stale literal', () => {
    expect(resource!.contents).toContain(`Resolves expected growth (${cov.growth.length})`);
  });

  it('lists the actual growth members and excludes the non-resolving symbols', () => {
    for (const t of cov.growth) expect(resource!.contents).toContain(t);
    // Symbols that resolve no growth must not be presented as covered.
    for (const t of cov.noGrowth) {
      expect(resource!.contents, `${t} resolves no growth and must not appear`).not.toMatch(
        new RegExp(`\\b${t}\\b`),
      );
    }
  });

  // The point of the change this file guards: volatility coverage is a
  // per-call property of a freshness-gated publication, so the resource must
  // describe the mechanism (including that a non-current vol resolves as
  // nothing) instead of publishing a roster that would be wrong the day it was
  // written. A future edit that pastes a vol symbol list back in fails here.
  it('describes the volatility mechanism instead of enumerating symbols', () => {
    expect(resource!.contents).toMatch(/last market close/i);
    expect(resource!.contents).toMatch(/no fixed list|no roster/i);
    expect(resource!.contents).not.toMatch(/Resolves volatility only/);
    expect(resource!.contents).not.toMatch(/Resolves both growth and volatility/);
  });

  it('promises no fallback when volatility does not resolve', () => {
    expect(resource!.contents).toMatch(/no fallback to an older number/i);
    expect(resource!.contents).toMatch(/required-field error naming `volatility`/);
  });
});
