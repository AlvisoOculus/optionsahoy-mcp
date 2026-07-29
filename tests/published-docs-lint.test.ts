// AlphaLatitude Inc. © 2026
//
// Drift guard for the CURATED published docs (llms.txt / llms-full.txt). Unlike
// toolspec.json these are hand-written narrative, so they are not generated; this
// lint instead asserts they never reintroduce the audited defects (wrong test
// count, phantom verdict, IP leaks, false freshness, em-dashes). Scans the mcp
// copies and the optionsahoy_web mirrors when the sibling repo is present.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import pkg from '../package.json';

const FILES = [
  'public/llms.txt',
  '../optionsahoy_web/web/public/llms.txt',
  '../optionsahoy_web/web/public/llms-full.txt',
];

// llms-full.txt is GENERATED (scripts/gen-llms-full.ts) but has no --check
// drift guard like toolspec/openapi, which is exactly how it once shipped a
// release behind the live tool descriptors. Freshness canaries: the stamped
// version must match package.json, and the current input contract (the
// "market" growth sentinel) must be present.
const LLMS_FULL = '../optionsahoy_web/web/public/llms-full.txt';
describe('llms-full.txt freshness canaries', () => {
  const present = existsSync(LLMS_FULL);
  const text = present ? readFileSync(LLMS_FULL, 'utf8') : '';
  it(`is stamped with the current version (v${pkg.version})`, () => {
    if (!present) { expect(true).toBe(true); return; }
    expect(text.includes(`optionsahoy-mcp v${pkg.version}`)).toBe(true);
  });
  it('documents the "market" growth sentinel', () => {
    if (!present) { expect(true).toBe(true); return; }
    expect(text.includes('the string "market"')).toBe(true);
  });
});

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
