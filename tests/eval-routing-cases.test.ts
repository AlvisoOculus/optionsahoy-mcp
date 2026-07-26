// AlphaLatitude Inc. © 2026
//
// CI-safe drift guard for the routing-eval dataset (scripts/eval/routing-cases.json).
// The eval itself (scripts/eval-routing.mts) costs money and needs credentials, so
// it never runs in CI — but the dataset must not rot as tools evolve: a renamed or
// removed tool would silently turn eval cases into guaranteed failures. This pins
// the dataset's structural contract against the canonical TOOLS array.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../functions/_lib/mcp-tools';

const data = JSON.parse(readFileSync('scripts/eval/routing-cases.json', 'utf8')) as {
  casesVersion: string;
  cases: {
    id: string;
    kind: string;
    utterance: string;
    expected: string | null;
    expectedSet?: string[];
    mustMention?: string[];
  }[];
};
const toolNames = new Set<string>(TOOLS.map((t) => t.name));

describe('routing-eval dataset drift guard', () => {
  it('has a casesVersion and unique ids', () => {
    expect(data.casesVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const ids = new Set(data.cases.map((c) => c.id));
    expect(ids.size).toBe(data.cases.length);
  });

  it('every expected tool reference exists in the canonical TOOLS array', () => {
    for (const c of data.cases) {
      // Loose != null: multi cases omit `expected` entirely (they carry expectedSet).
      if (c.expected != null) {
        expect(toolNames.has(c.expected), `${c.id}: unknown tool ${c.expected}`).toBe(true);
      }
      for (const t of c.expectedSet ?? []) {
        expect(toolNames.has(t), `${c.id}: unknown tool ${t} in expectedSet`).toBe(true);
      }
    }
  });

  it('kinds are valid and carry the fields their grading requires', () => {
    for (const c of data.cases) {
      expect(['single', 'ambiguous', 'negative', 'multi']).toContain(c.kind);
      expect(c.utterance.length).toBeGreaterThan(0);
      if (c.kind === 'single') expect(c.expected, c.id).toBeTypeOf('string');
      if (c.kind === 'negative' || c.kind === 'ambiguous') expect(c.expected, c.id).toBeNull();
      if (c.kind === 'ambiguous') expect((c.mustMention ?? []).length, c.id).toBeGreaterThan(0);
      if (c.kind === 'multi') expect((c.expectedSet ?? []).length, c.id).toBeGreaterThan(1);
    }
  });

  it('per-kind counts stay at or above the designed floor', () => {
    const counts: Record<string, number> = {};
    for (const c of data.cases) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
    // Floors, not exact counts: the set is append-only (casesVersion bumps on add).
    expect(counts.single ?? 0).toBeGreaterThanOrEqual(140);
    expect(counts.ambiguous ?? 0).toBeGreaterThanOrEqual(15);
    expect(counts.negative ?? 0).toBeGreaterThanOrEqual(25);
    expect(counts.multi ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('contains no em-dash (repo-wide agent-surface lint convention)', () => {
    expect(readFileSync('scripts/eval/routing-cases.json', 'utf8')).not.toMatch(/—/);
  });
});
