// AlphaLatitude Inc. © 2026
//
// Phase 4 (code<->docs consistency) + Phase 6 (voice/IP lint) over the MCP tool
// descriptions and schemas that agents read. Binds the agent-facing strings to
// the engine: a description cannot reintroduce a phantom enum, a wrong test
// count, an IP leak, or an em-dash without a test failing. Covers defects
// M1-M6, M9, M10 (Batch A).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../functions/_lib/mcp-tools';
import { PROMPTS } from '../functions/_lib/mcp-prompts';
import { QSBS_INDUSTRY_OPTIONS } from '../lib/calc/qsbs';
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

// The server `instructions` tell the model that a field outside `required` is
// one of three kinds: defaulted (omit it), resolvable another way (still needs
// a real value), or required under a stated condition. That claim is only safe
// if EVERY optional field actually says which kind it is, in words strong
// enough to distinguish them - the bare word "optional" does not. An optional
// field whose description explains neither leaves the model with two bad
// options -- invent a number, or interrogate the user about a field that did
// not need asking -- and the first is the failure mode the whole input
// contract exists to prevent.
describe('every optional field documents its optionality (backs the instructions contract)', () => {
  // STRONG tokens only. An earlier version also accepted the bare words
  // "optional" and "default" and the provenance phrase "must come from the
  // user", which let a description saying only "Optional." pass while
  // explaining nothing about which kind of optional field it is.
  // One alternation per kind of optional field, so a match means the
  // description actually told the caller what omitting the field does:
  //   defaulted            -> "defaults to X" / "Default 0.10" / "no built-in default"
  //   resolvable elsewhere -> "required unless", "resolution order", "alternative to"
  //   conditionally needed -> "required only when", "required with"
  //   pure enhancer        -> "when set", "when supplied", "not used in pricing"
  // The bare words "optional" and "default" are deliberately NOT accepted: a
  // description reading only "Optional." satisfied the earlier version while
  // explaining nothing.
  const EXPLAINS_OPTIONALITY = new RegExp(
    [
      /defaults? to|\bdefault\b\s*[:=]?\s*["'\d]|no built-in default|falls back to/,
      /required unless|resolution order|alternative to|provide either|pair with legacy|resolves it|inherits/,
      /required only when|required with/,
      /when set|when supplied|not used in pricing/,
    ]
      .map((r) => r.source)
      .join('|'),
    'i',
  );
  for (const tool of TOOLS) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    const required = new Set((tool.inputSchema.required ?? []) as string[]);
    for (const name of Object.keys(props)) {
      if (required.has(name)) continue;
      it(`${tool.name}.${name}`, () => {
        const d = String(props[name].description ?? '');
        expect(d.length, `${tool.name}.${name} has no description`).toBeGreaterThan(0);
        expect(
          EXPLAINS_OPTIONALITY.test(d),
          `${tool.name}.${name} is optional but its description never says whether it defaults or must be resolved: "${d.slice(0, 120)}"`,
        ).toBe(true);
      });
    }
  }
});

// The schema told MCP clients that hospitality is a qualifying industry while
// the engine returns qualifies:false for it, and filed farming and extraction
// as service businesses when the statute excludes them separately. A client
// reading inputSchema got the opposite of what the tool computes. Bind the
// prose to the engine table so the two cannot drift again.
describe('qsbs_check industry description matches the engine table', () => {
  const desc = String(
    (byName['qsbs_check'].inputSchema.properties as Record<string, { description?: string }>).industry.description,
  );
  const qualifying = QSBS_INDUSTRY_OPTIONS.filter((o) => o.qualifies === true).map((o) => o.value);
  const excluded = QSBS_INDUSTRY_OPTIONS.filter((o) => o.qualifies === false).map((o) => o.value);

  it('names every qualifying industry', () => {
    for (const v of qualifying) expect(desc, `missing qualifying ${v}`).toContain(v);
  });

  it('never presents an excluded industry as qualifying', () => {
    // The qualifying claim is the explicit list after "qualify:", up to its
    // sentence end. Slicing at the first "do NOT qualify" instead would sweep
    // in the excluded values named in the clause that precedes that phrase.
    const m = desc.match(/qualify:\s*([^.]+)\./i);
    expect(m, 'no explicit "qualify: a, b, c." list in the description').not.toBeNull();
    const qualifyingList = m![1]!;
    for (const v of qualifying) {
      expect(qualifyingList, `${v} qualifies but is not in the qualifying list`).toContain(v);
    }
    for (const v of excluded) {
      expect(qualifyingList, `${v} is qualifies:false but sits in the qualifying list`).not.toContain(v);
    }
  });
});

// ── lhm.plugin.json is a HAND-MAINTAINED mirror ──────────────────────────
// Unlike public/toolspec.json and public/openapi.json, this descriptor has no
// generator in this repo (checked: scripts/, scripts/codegen/, package.json).
// It is published to a third-party directory, so a stale copy is a stale claim
// in front of real users - which is exactly how the "cached implied volatility"
// wording outlived the cached table it described. Until it gains a generator,
// this test IS the drift guard: edit mcp-prompts.ts, then mirror the same
// strings here, and this fails until you do.
describe('lhm.plugin.json mirrors the prompt source of truth', () => {
  const plugin = JSON.parse(readFileSync('lhm.plugin.json', 'utf8')) as {
    prompts: Array<{ name: string; description: string; arguments?: Array<{ name: string; description: string }> }>;
  };
  const byPromptName = new Map(plugin.prompts.map((p) => [p.name, p]));

  for (const prompt of PROMPTS) {
    it(`${prompt.name}: description and argument text match`, () => {
      const mirrored = byPromptName.get(prompt.name);
      expect(mirrored, `lhm.plugin.json is missing prompt "${prompt.name}"`).toBeDefined();
      expect(mirrored!.description).toBe(prompt.description);
      for (const arg of prompt.arguments ?? []) {
        const mirroredArg = (mirrored!.arguments ?? []).find((a) => a.name === arg.name);
        expect(mirroredArg, `missing argument "${arg.name}"`).toBeDefined();
        expect(mirroredArg!.description).toBe(arg.description);
      }
    });
  }
});

// The published surfaces must not describe the RETIRED mechanism. Volatility
// stopped coming from a table baked into the package (lib/data/trailing-vols)
// in 2026-08; it now resolves per call from a published feed behind a
// last-close freshness gate. A surface still saying "cached implied vol" tells
// a model, and through it a user, something false about where the number came
// from and how current it is.
describe('no surface still claims a cached implied-vol table', () => {
  const SURFACES = [
    'AGENTS.md',
    'GEMINI.md',
    'README.md',
    'lhm.plugin.json',
    'public/toolspec.json',
    'functions/_lib/mcp-tools.ts',
    'functions/_lib/mcp-prompts.ts',
    'functions/_lib/mcp-resources.ts',
    'functions/_lib/calc-parsers.ts',
    'integrations/aci/optionsahoy/functions.json',
    'examples/quickstart/README.md',
    'examples/quickstart/call-concentration.mjs',
    'integrations/recipes/price_protective_put_or_collar.py',
  ];
  const STALE = /cached implied[- ]vol|implied[- ]vol(atility)? table|cached vol/i;
  for (const path of SURFACES) {
    it(`${path}`, () => {
      expect(readFileSync(path, 'utf8')).not.toMatch(STALE);
    });
  }
});
