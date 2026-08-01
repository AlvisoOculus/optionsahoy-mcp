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
  // Directory-review claims (2026-08-01). "Relevant federal tax code" is the
  // scoped wording; the engine models the pieces it names, not the whole code.
  // Optimality is stated per tool (only the ISO optimizer is exhaustively
  // searched and brute-force checked), never as a blanket superlative.
  ['unscoped full-tax-code claim', /full (US )?federal tax code|full federal plus|full tax-code coverage/i],
  ['unscoped globally-optimal claim', /globally[-\s]optimal/i],  // \s: the phrase wraps across lines in READMEs
  ['unverifiable LLM-capability claim', /than an LLM can reason through/i],
  // The benchmark has two denominators and they yield different numbers:
  // stated-vs-own-schedule is 2x to 20x (the published write-up's headline),
  // stated-vs-provable-optimum is 1.6x to 17.6x. Attaching the 2x-20x figure
  // to "the achievable outcome/optimum" mixes them, which is what shipped on
  // a dozen surfaces until 2026-08-01. Quote the range that matches the
  // denominator you name.
  ['benchmark denominator conflation', /(achievable|optimum)[^.]{0,40}by (roughly )?2[x-]\s?to\s?20x|(achievable|optimum)[^.]{0,40}by 2-20x/i],
];

// The two claims the Anthropic directory review asked us to soften, guarded
// across every artifact that publishes them - including the ones the first
// sweep missed because they are neither generated nor previously linted:
// mcpb/manifest.json ships inside the Desktop extension bundle and the ACI
// descriptors are published to ACI.dev. Only the claim patterns apply here;
// these files carry their own conventions for the rest of BANNED.
const CLAIM_FILES = [
  'mcpb/manifest.json',
  'integrations/aci/optionsahoy/functions.json',
  'README.md',
  'AGENTS.md',
  'GEMINI.md',
  'public/openapi.json',
  'functions/_lib/mcp-instructions.ts',
  // The descriptor source of record and its generated projection. Omitting
  // these is why "tractable problem sizes" survived a whole review round on
  // the one payload a directory reviewer fetches programmatically.
  'functions/_lib/mcp-tools.ts',
  'public/toolspec.json',
  // Published package descriptions (npm / PyPI) and the Zed extension listing.
  'integrations/zed/README.md',
  'integrations/js/optionsahoy-ai-sdk/README.md',
  'integrations/python/optionsahoy/README.md',
  'integrations/python/optionsahoy-langchain/README.md',
  'integrations/python/optionsahoy-pydantic-ai/README.md',
  'integrations/python/optionsahoy-openai-agents/README.md',
  'integrations/python/arcade-optionsahoy/README.md',
  'integrations/python/crewai-optionsahoy/README.md',
  'integrations/python/llama-index-tools-optionsahoy/README.md',
  'integrations/eval/README.md',
  'integrations/openrouter-bridge/README.md',
];
const CLAIM_BANNED = BANNED.filter(([label]) =>
  label === 'unscoped full-tax-code claim' ||
  label === 'unscoped globally-optimal claim' ||
  label === 'unverifiable LLM-capability claim' ||
  label === 'false daily-refreshed claim' ||
  label === 'eight tests',
);
for (const file of CLAIM_FILES) {
  describe(`directory-review claim lint: ${file}`, () => {
    // Every CLAIM_FILE is in-repo, so a rename must fail the guard rather than
    // silently disable it (the ../optionsahoy_web mirrors in FILES above are
    // the only entries allowed to be absent).
    it('exists', () => {
      expect(existsSync(file), `${file} is listed in CLAIM_FILES but missing`).toBe(true);
    });
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const [label, re] of CLAIM_BANNED) {
      it(`no ${label}`, () => {
        expect(re.test(text), `${file} contains ${label}`).toBe(false);
      });
    }
  });
}

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
