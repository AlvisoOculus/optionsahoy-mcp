// AlphaLatitude Inc. © 2026
//
// Drift guard for the ticker-coverage partition and the covered-tickers MCP
// resource generated from it. The counts are intentionally NOT hardcoded: the
// bundled trailing-returns / trailing-vols snapshots refresh from the ETL, so
// the exact numbers move by a symbol or two between deploys. These assert the
// partition is internally consistent, that it agrees with the readers the
// parsers actually use (hasTrailingReturn / hasTrailingVol), and that the
// resource body's stated numbers are recomputed from the same source rather
// than a stale literal.

import { describe, it, expect } from 'vitest';
import { tickerCoverage } from '../lib/data/ticker-coverage';
import { RESOURCES } from '../functions/_lib/mcp-resources';

const cov = tickerCoverage();
const growthTotal = cov.growthAndVol.length + cov.growthOnly.length;
const volTotal = cov.growthAndVol.length + cov.volOnly.length;
const resource = RESOURCES.find((r) => r.uri === 'https://optionsahoy.com/tools/covered-tickers');

// tickerCoverage() partitions by calling hasTrailingReturn/hasTrailingVol
// directly, so an "every growth bucket really resolves growth" test would be a
// tautology. These assert the structural properties that reuse does NOT make
// free: disjointness, sortedness, a real (non-empty) snapshot, and that the
// resource body's numbers are recomputed from the partition rather than stale.
describe('tickerCoverage partition', () => {
  it('buckets are disjoint (no symbol double-counted)', () => {
    const all = [...cov.growthAndVol, ...cov.growthOnly, ...cov.volOnly, ...cov.neither];
    expect(new Set(all).size).toBe(all.length);
  });

  it('sorts each bucket and includes SPY as a fully-covered index proxy', () => {
    for (const b of [cov.growthAndVol, cov.growthOnly, cov.volOnly, cov.neither]) {
      expect(b).toEqual([...b].sort());
    }
    expect(cov.growthAndVol).toContain('SPY'); // in both tables, the canonical smoke case
  });

  it('has real coverage (guards against an empty/broken snapshot import)', () => {
    expect(growthTotal).toBeGreaterThan(40);
    expect(volTotal).toBeGreaterThan(40);
  });
});

describe('covered-tickers resource', () => {
  it('is registered with the tools/ URI and markdown mime type', () => {
    expect(resource).toBeDefined();
    expect(resource!.uri).toMatch(/^https:\/\/optionsahoy\.com\/tools\//);
    expect(resource!.mimeType).toBe('text/markdown');
    expect(resource!.description.length).toBeGreaterThan(20);
  });

  it('states counts recomputed from tickerCoverage, not a stale literal', () => {
    // The body interpolates the live counts; assert the exact current numbers
    // appear so a divergence between the body and the partition fails here.
    expect(resource!.contents).toContain(`${growthTotal} symbols resolve expected growth`);
    expect(resource!.contents).toContain(`${volTotal} resolve volatility`);
    expect(resource!.contents).toContain(`Resolves both growth and volatility (${cov.growthAndVol.length})`);
    expect(resource!.contents).toContain(`Resolves growth only (${cov.growthOnly.length})`);
    expect(resource!.contents).toContain(`Resolves volatility only (${cov.volOnly.length})`);
  });

  it('lists the actual bucket members and excludes the "neither" symbols', () => {
    for (const t of cov.growthAndVol) expect(resource!.contents).toContain(t);
    // Symbols that resolve nothing usable must not be presented as covered.
    for (const t of cov.neither) {
      expect(resource!.contents, `${t} resolves neither and must not appear`).not.toMatch(
        new RegExp(`\\b${t}\\b`),
      );
    }
  });
});
