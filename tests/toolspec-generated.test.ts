// AlphaLatitude Inc. © 2026
//
// Drift guard: the published toolspec.json copies must equal what the TOOLS
// source generates (buildToolSpec). If a tool description/schema changes without
// regenerating, or a copy is hand-edited, this fails -- run `npm run gen:toolspec`.
// The mcp copy is checked strictly; the cross-repo optionsahoy_web copy is checked
// only when present (it is a sibling checkout, absent in some CI).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildToolSpec } from '../functions/_lib/mcp-tools';

const expected = buildToolSpec();

describe('toolspec.json is generated from TOOLS (no drift)', () => {
  it('mcp copy (public/toolspec.json) matches the source', () => {
    const onDisk = JSON.parse(readFileSync('public/toolspec.json', 'utf8'));
    expect(onDisk).toEqual(expected);
  });

  it('web mirror (optionsahoy_web) matches the source when present', () => {
    const path = '../optionsahoy_web/web/public/toolspec.json';
    if (!existsSync(path)) {
      expect(true).toBe(true); // skipped: sibling repo not checked out
      return;
    }
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual(expected);
  });
});
