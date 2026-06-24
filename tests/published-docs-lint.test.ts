// AlphaLatitude Inc. © 2026
//
// Drift guard for the CURATED published docs (llms.txt / llms-full.txt). Unlike
// toolspec.json these are hand-written narrative, so they are not generated; this
// lint instead asserts they never reintroduce the audited defects (wrong test
// count, phantom verdict, IP leaks, false freshness, em-dashes). Scans the mcp
// copies and the optionsahoy_web mirrors when the sibling repo is present.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const FILES = [
  'public/llms.txt',
  '../optionsahoy_web/web/public/llms.txt',
  '../optionsahoy_web/web/public/llms-full.txt',
];

const BANNED: Array<[string, RegExp]> = [
  ['eight tests', /eight statutory tests|eight tests/i],
  ['phantom does-not-qualify verdict', /does-not-qualify/],
  ['false daily-refreshed claim', /daily-refreshed/],
  ['Black-Scholes model name', /Black-?Scholes/],
  ['IV multiplier constant', /IV_OVER_RV_MULTIPLIER/],
  ['magic multiplier 1.20', /\b1\.20\b/],
  ['internal vol-table name', /sector_stats|sector-stats\.ts/],
  ['source path', /web\/lib\/calc|lib\/calc\/\*/],
  ['search-strategy IP', /chunk-grid|\bgreedy\b|1-share refinement/],
  ['em-dash', /—/],
];

for (const file of FILES) {
  describe(`published doc lint: ${file}`, () => {
    const present = existsSync(file);
    const text = present ? readFileSync(file, 'utf8') : '';
    for (const [label, re] of BANNED) {
      it(`no ${label}`, () => {
        if (!present) { expect(true).toBe(true); return; } // sibling repo not checked out
        expect(re.test(text), `${file} contains ${label}`).toBe(false);
      });
    }
  });
}
