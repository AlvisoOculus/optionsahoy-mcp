// AlphaLatitude Inc. © 2026
//
// Phase 5: bind the MCP resource + prompt tax briefings to the engine's own
// constants, so a briefing cannot drift from the calculator. Covers the
// engine-derivable Batch-B facts (B1, B2, B4, B6, B7, B14, the six-tests count,
// the verdict enum) plus the voice/IP lint (em-dash, Black-Scholes, false
// "daily-refreshed" claim). The non-engine-derivable items (B3, B11, B12, B13)
// are corrected in prose and flagged for manual sign-off, not asserted here.

import { describe, it, expect } from 'vitest';
import { RESOURCES } from '../functions/_lib/mcp-resources';
import { PROMPTS } from '../functions/_lib/mcp-prompts';
import { evaluateQsbs, OBBBA_CUTOFF, type QsbsInputs } from '@/lib/calc/qsbs';
import { SS_WAGE_BASE_2026 } from '@/lib/tax/fica-2026';

const byUri = (frag: string) => RESOURCES.find((r) => r.uri.includes(frag))!;
const qsbs = byUri('qsbs');
const amt = byUri('amt-crossover');
const nso = byUri('nso-sell-vs-hold');
const collars = byUri('zero-cost-collars');
const allResourceText = RESOURCES.map((r) => r.contents + r.description).join('\n');
const allPromptText = PROMPTS.map((p) => p.description + JSON.stringify(p.arguments) + p.build({}).map((m) => m.content.text).join('\n')).join('\n');

describe('resources/prompts: voice + IP lint', () => {
  it('no em-dash in resources', () => expect(/—/.test(allResourceText)).toBe(false));
  it('no em-dash in prompts', () => expect(/—/.test(allPromptText)).toBe(false));
  it('no Black-Scholes model name (resources)', () => expect(/Black-?Scholes/.test(allResourceText)).toBe(false));
  it('no Black-Scholes model name (prompts)', () => expect(/Black-?Scholes/.test(allPromptText)).toBe(false));
  it('no false daily-refreshed vol-surface claim', () => {
    expect(/daily-refreshed/.test(allResourceText + allPromptText)).toBe(false);
  });
});

describe('QSBS briefing bound to the engine', () => {
  it('engine returns six tests (the briefing must say six, never eight)', () => {
    const sample: QsbsInputs = {
      acquisitionDate: new Date('2018-01-01'), saleDate: new Date('2026-06-01'),
      entityType: 'us-c-corp', acquisitionMethod: 'original-issuance', assetCategory: 'under-50m',
      industry: 'tech-software', activeBusiness: 'yes', adjustedBasis: 100_000, expectedGain: 5_000_000,
      stateCode: 'CA', ordinaryIncome: 250_000, filingStatus: 'single',
    };
    expect(evaluateQsbs(sample).tests.length).toBe(6);
    expect(/eight statutory tests|eight tests|the eight/i.test(qsbs.contents + qsbs.description)).toBe(false);
    expect(/six (statutory |qualification |core )?tests/i.test(qsbs.contents)).toBe(true);
  });
  it('OBBBA cutoff prose matches the engine constant (B1)', () => {
    // OBBBA_CUTOFF is 2025-07-04; the briefing must name that date, not "the effective date".
    expect(new Date(OBBBA_CUTOFF).toISOString().slice(0, 10)).toBe('2025-07-04');
    expect(/July 4, 2025/.test(qsbs.contents)).toBe(true);
  });
  it('states the 50/75/100% tiers at 3/4/5 years (B2)', () => {
    expect(/50%.*3|3.*50%/s.test(qsbs.contents)).toBe(true);
    expect(/75%.*4|4.*75%/s.test(qsbs.contents)).toBe(true);
    expect(/100%.*5|5.*100%/s.test(qsbs.contents)).toBe(true);
  });
  it('non-conforming state list matches the engine: CA/AL/PA/MS, NJ 2026+, HI/MA partial (B6)', () => {
    const c = qsbs.contents;
    for (const s of ['California', 'Alabama', 'Pennsylvania', 'Mississippi']) expect(c.includes(s)).toBe(true);
    expect(/New Jersey conforms|New Jersey.*2026/.test(c)).toBe(true);
    expect(/Hawaii|Massachusetts/.test(c)).toBe(true);
    // The old wrong claim listed NJ as flatly non-conforming alongside the four.
    expect(/New Jersey, Mississippi, and Alabama do not conform/.test(c)).toBe(false);
  });
  it('verdict enum uses the real five values, not "qualified/disqualified" (N2)', () => {
    expect(/qualified \/ disqualified \/ partial/.test(qsbs.contents)).toBe(false);
    expect(/too-soon/.test(qsbs.contents)).toBe(true);
    expect(/caveats/.test(qsbs.contents)).toBe(true);
  });
});

describe('AMT + NSO + FICA briefings', () => {
  it('AMT stated as 26% or 28%, not a flat 28% (B4)', () => {
    expect(/26%/.test(amt.contents)).toBe(true);
    expect(/28%/.test(amt.contents)).toBe(true);
  });
  it('Social Security wage base matches the engine constant (B14)', () => {
    expect(nso.contents.includes(SS_WAGE_BASE_2026.toLocaleString('en-US'))).toBe(true);
  });
});

describe('prompts bound to the parser', () => {
  it('analyze-nso-decision marks holdYears required (parser requires >=1) (B7)', () => {
    const p = PROMPTS.find((x) => x.name === 'analyze-nso-decision')!;
    const hy = p.arguments.find((a) => a.name === 'holdYears')!;
    expect(hy.required).toBe(true);
  });
  it('check-qsbs prompt says six tests, never eight', () => {
    const p = PROMPTS.find((x) => x.name === 'check-qsbs-eligibility')!;
    const text = p.description + p.build({}).map((m) => m.content.text).join('\n');
    expect(/eight statutory tests|eight tests/i.test(text)).toBe(false);
    expect(/six (statutory )?tests/i.test(text)).toBe(true);
  });
  it('check-qsbs prompt verdict enum uses real values (N2)', () => {
    const p = PROMPTS.find((x) => x.name === 'check-qsbs-eligibility')!;
    const text = p.build({}).map((m) => m.content.text).join('\n');
    expect(/qualified \/ disqualified \/ partial/.test(text)).toBe(false);
  });
});
