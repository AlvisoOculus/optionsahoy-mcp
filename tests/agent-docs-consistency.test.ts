// AlphaLatitude Inc. © 2026
//
// Phase 4 (code<->docs consistency) + Phase 6 (voice/IP lint) over the MCP tool
// descriptions and schemas that agents read. Binds the agent-facing strings to
// the engine: a description cannot reintroduce a phantom enum, a wrong test
// count, an IP leak, or an em-dash without a test failing. Covers defects
// M1-M6, M9, M10 (Batch A).

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../functions/_lib/mcp-tools';
import { evaluateQsbs, type QsbsInputs } from '@/lib/calc/qsbs';

const byName: Record<string, any> = Object.fromEntries(TOOLS.map((t: any) => [t.name, t]));
const blob = (t: any) => [t.description, JSON.stringify(t.inputSchema), JSON.stringify(t.outputSchema)].join('\n');

describe('MCP tool docs: voice/IP lint', () => {
  // NOTE: "risk-neutral" is intentionally allowed (the premium math IS
  // risk-neutral); the mislabel is checked field-specifically below.
  const banned: Array<[string, RegExp]> = [
    ['em-dash', /—/],
    ['source path (lib/)', /lib\//],
    ['internal vol-table name', /sector-stats\.ts|sector_stats/],
    ['magic multiplier 1.20', /\b1\.20\b/],
    ['IV multiplier constant name', /IV_OVER_RV_MULTIPLIER/],
    ['model name Black-Scholes', /Black-?Scholes/],
    ['search-strategy phrasing', /\bgreedy\b|chunk-grid|1-share refinement/],
  ];
  for (const tool of TOOLS) {
    const s = blob(tool);
    for (const [label, re] of banned) {
      it(`${tool.name}: no ${label}`, () => {
        expect(re.test(s), `${tool.name} contains ${label}`).toBe(false);
      });
    }
  }
});

describe('tool descriptions lead with a natural-language trigger (runtime selectability)', () => {
  // The #1 lever for an agent picking the right tool is description<->query
  // semantic match. Every tool must open with a "Use this when someone asks ..."
  // trigger phrased the way users actually ask, so it can't regress to a
  // feature-only opening.
  for (const tool of TOOLS) {
    it(`${tool.name}: opens with a "Use this when" trigger`, () => {
      expect(/Use this when someone asks/i.test(String(tool.description))).toBe(true);
    });
  }
  // Spot-check that the trigger carries the real user vocabulary per tool.
  const has = (name: string, re: RegExp) => re.test(String(byName[name].description));
  it('triggers use the vocabulary users actually use', () => {
    expect(has('amt_iso_optimize', /exercise .*incentive stock options|alternative minimum tax \(AMT\)/i)).toBe(true);
    expect(has('rsu_sell_vs_hold', /sell RSUs at vest or hold/i)).toBe(true);
    expect(has('qsbs_check', /qualifies for the qualified small business stock/i)).toBe(true);
    expect(has('equity_funding_plan', /which shares to sell and when to reach a cash goal/i)).toBe(true);
  });
});

describe('QSBS docs bound to the engine', () => {
  const sample: QsbsInputs = {
    acquisitionDate: new Date('2018-01-01'),
    saleDate: new Date('2026-06-01'),
    entityType: 'us-c-corp',
    acquisitionMethod: 'original-issuance',
    assetCategory: 'under-50m',
    industry: 'tech-software',
    activeBusiness: 'yes',
    adjustedBasis: 100_000,
    expectedGain: 5_000_000,
    stateCode: 'CA',
    ordinaryIncome: 250_000,
    filingStatus: 'single',
  };
  const s = blob(byName['qsbs_check']);

  it('engine returns exactly six tests', () => {
    expect(evaluateQsbs(sample).tests.length).toBe(6);
  });
  it('docs say six tests, never eight', () => {
    expect(/eight (statutory )?tests|each of the eight|the eight/i.test(s)).toBe(false);
    expect(/six statutory tests|six tests/i.test(s)).toBe(true);
  });
  it('no phantom does-not-qualify verdict', () => {
    expect(/does-not-qualify/.test(s)).toBe(false);
  });
  it('no phantom "expected gain at sale" / "adjusted basis" test entries', () => {
    expect(/expected gain at sale/.test(s)).toBe(false);
  });
  it('perIssuerCap doc notes the $15M OBBBA cap (M9)', () => {
    expect(/\$15M|15,000,000|\$15 ?million/i.test(s)).toBe(true);
  });
  it('era label uses the engine value pre-2010, not 2009-2010', () => {
    expect(/2009-2010/.test(s)).toBe(false);
  });
});

describe('NSO / protective_put / concentration field accuracy', () => {
  it('nso hold uses ltcg* and has no capGain*/isLongTerm (M2)', () => {
    const s = blob(byName['nso_calculate']);
    expect(/capGainFederal|capGainState|capGainTotal/.test(s)).toBe(false);
    expect(/isLongTerm/.test(s)).toBe(false);
    expect(/ltcgFederal/.test(s)).toBe(true);
  });
  it('protective_put expectedReturn field says real-world drift, not risk-neutral (M4)', () => {
    const f = byName['protective_put_price'].inputSchema.properties.expectedReturn.description as string;
    expect(/risk-neutral drift/.test(f)).toBe(false);
    expect(/real-world drift/.test(f)).toBe(true);
  });
  it('concentration does not over-claim hedging NFV / inert hedgeChoice (M3)', () => {
    const s = blob(byName['concentration_analyze']);
    expect(/NFV \+ cost/.test(s)).toBe(false);
    expect(/post-tax NFV of the hedged/.test(s)).toBe(false);
  });
});
