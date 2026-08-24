// AlphaLatitude Inc. © 2026
//
// The lazy-warm gate: `mayResolveVolFromTicker`.
//
// Every request handler used to `await warmVolSnapshot()` unconditionally,
// paying a cold-memo CDN fetch (up to the full timeout, now up to the retry
// budget) on requests that provably cannot read the memo. The predicate makes
// that await conditional, which is a PERFORMANCE change that must be a
// behaviour NO-OP.
//
// This file is the proof, and it is deliberately written as a property rather
// than as a list of examples: for every representative input the predicate
// calls FALSE, parsing must produce a byte-identical outcome - same resolved
// input, or same thrown message - with a cold memo and with a warm one. If it
// does not, the gate skipped a warm that mattered.
//
// Mutation checks this file is built to catch:
//   - predicate hardcoded TRUE  -> the explicit `toBe(false)` assertions fail
//     (a perf gate cannot be caught by a behaviour test, so those are asserted
//     directly).
//   - predicate hardcoded FALSE -> the property runs on the ticker-resolving
//     inputs too, and they differ cold-vs-warm, so it fails.
//   - a vol-resolving tool dropped from the table -> same as hardcoded false,
//     for that tool.

import { describe, it, expect } from 'vitest';
import {
  mayResolveVolFromTicker,
  parseAmtIsoInput,
  parseConcentrationInput,
  parseEquityFundingInput,
  parseNsoInput,
  parseProtectivePutInput,
  parseQsbsInput,
  parseRsuInput,
  parseRsuLotOptimizeInput,
} from '../functions/_lib/calc-parsers';
import { partsMayResolveVol, type A2APart } from '../functions/_lib/a2a';
import { clearVols, seedFreshVols } from './helpers/live-vols-fixture';

// Two parsers stamp the SERVER CLOCK into their resolved input (`today`), at
// millisecond precision. Comparing a cold parse against a warm one would then
// compare two different wall-clock reads and fail roughly whenever the two
// calls straddle a millisecond boundary - a flake that has nothing to do with
// the memo. Both accept an injected `trustedToday` for exactly this reason.
const FIXED_TODAY = new Date('2026-08-19T12:00:00Z');

// The real dispatch table, by MCP tool name (= A2A skill id).
const PARSERS: Record<string, (raw: unknown) => unknown> = {
  amt_iso_optimize: parseAmtIsoInput,
  nso_calculate: parseNsoInput,
  rsu_sell_vs_hold: parseRsuInput,
  concentration_analyze: parseConcentrationInput,
  protective_put_price: parseProtectivePutInput,
  qsbs_check: parseQsbsInput,
  equity_funding_plan: (raw) => parseEquityFundingInput(raw, FIXED_TODAY),
  rsu_lot_optimize: (raw) => parseRsuLotOptimizeInput(raw, FIXED_TODAY),
};

// MCP tool name -> REST slug. runCalc gates on the slug, so both spellings of
// every tool have to be in the predicate's table.
const REST_SLUG: Record<string, string> = {
  amt_iso_optimize: 'amt-iso',
  nso_calculate: 'nso',
  rsu_sell_vs_hold: 'rsu-sell-vs-hold',
  concentration_analyze: 'concentration',
  protective_put_price: 'protective-put',
  qsbs_check: 'qsbs',
  equity_funding_plan: 'equity-funding',
  rsu_lot_optimize: 'rsu-lot-order',
};

const AMT = {
  shares: 10000, strike: 2, fmv: 200, expectedGrowth: 0.15,
  filingStatus: 'married_joint', ordinaryIncome: 400000, stateCode: 'CA',
  carryforwardCredit: 0, horizon: 4, cashReturnRate: 0.05,
  grantDate: '2022-01-15', hasLeftCompany: false, terminationDate: null,
};
const NSO = {
  shares: 1000, strike: 5, currentPrice: 50, ordinaryIncome: 200000,
  filingStatus: 'single', stateCode: 'CA', stillEmployed: true, holdYears: 3,
  expectedSalePrice: 80, expectedMarketReturn: 0.07, holdFunding: 'cash',
};
const RSU = {
  shares: 500, currentPrice: 80, ordinaryIncome: 200000, filingStatus: 'single',
  stateCode: 'CA', stillEmployed: true, holdYears: 2, expectedSalePrice: 100,
  expectedMarketReturn: 0.07,
};
const CONC = {
  positionValue: 1000000, costBasis: 200000, acquisitionDate: '2022-01-15',
  sector: 'tech_software', stateCode: 'CA', filingStatus: 'single',
  ordinaryIncome: 250000, totalAssets: 1500000, expectedPositionReturn: 0.1,
  expectedMarketReturn: 0.07,
};
const PUT = { positionValue: 500000, sector: 'tech_software', protectionLevel: 0.2, tenorYears: 1 };
const QSBS = {
  acquisitionDate: '2020-03-01', saleDate: '2026-03-15', entityType: 'us-c-corp',
  acquisitionMethod: 'original-issuance', assetCategory: 'under-50m',
  industry: 'tech-software', activeBusiness: 'yes', adjustedBasis: 50000,
  expectedGain: 5000000, stateCode: 'CA', ordinaryIncome: 300000, filingStatus: 'single',
};
const FUNDING = {
  targetAfterTax: 500000,
  // Future relative to FIXED_TODAY (the parser rejects a past deadline), and
  // literal rather than clock-derived so the fixture cannot drift.
  targetDate: '2027-08-19',
  ordinaryIncome: 250000, filingStatus: 'single', stateCode: 'CA',
  stacks: [{
    ticker: 'NVDA', currentPrice: 100, expectedAnnualGrowth: 0.1,
    lots: [{ shares: 10000, costBasisPerShare: 20, acquisitionDate: '2023-01-15' }],
  }],
};
const LOTS = {
  lots: [
    { vestDate: '2022-08-15', shares: 120, costBasisPerShare: 95 },
    { vestDate: '2024-02-15', shares: 100, costBasisPerShare: 130 },
  ],
  currentPrice: 180, divestFraction: 0.5, horizonYears: 2,
  ordinaryIncome: 200000, filingStatus: 'single', stateCode: 'CA',
};

type Case = { label: string; tool: string; args: unknown };

// Representative inputs spanning every tool and every shape the gate reasons
// about: ticker-only, ticker + explicit volatility, ticker + the tool's drag
// short-circuit, no ticker at all, non-vol tools carrying a ticker anyway, and
// malformed payloads.
const CASES: Case[] = [
  // --- the cases the gate must let through ---
  { label: 'amt_iso: ticker, no volatility', tool: 'amt_iso_optimize', args: { ...AMT, ticker: 'NVDA' } },
  { label: 'nso: ticker, no volatility', tool: 'nso_calculate', args: { ...NSO, ticker: 'AAPL' } },
  { label: 'rsu: ticker, no volatility', tool: 'rsu_sell_vs_hold', args: { ...RSU, ticker: 'MSFT' } },
  { label: 'concentration: ticker, no volatility', tool: 'concentration_analyze', args: { ...CONC, ticker: 'NVDA' } },
  { label: 'protective_put: ticker, no volatility', tool: 'protective_put_price', args: { ...PUT, ticker: 'NVDA' } },
  // concentration reads sigma a SECOND time for hedge pricing, independent of
  // volatilityDrag - so a supplied drag does NOT short-circuit it.
  { label: 'concentration: ticker + volatilityDrag', tool: 'concentration_analyze', args: { ...CONC, ticker: 'NVDA', volatilityDrag: 0.2 } },
  { label: 'amt_iso: ticker, uncovered symbol', tool: 'amt_iso_optimize', args: { ...AMT, ticker: 'BOGUS' } },
  { label: 'protective_put: ticker, uncovered symbol', tool: 'protective_put_price', args: { ...PUT, ticker: 'BOGUS' } },

  // --- the cases the gate must skip ---
  { label: 'amt_iso: explicit volatility beside a ticker', tool: 'amt_iso_optimize', args: { ...AMT, ticker: 'NVDA', volatility: 0.5 } },
  { label: 'amt_iso: no ticker at all', tool: 'amt_iso_optimize', args: { ...AMT, volatility: 0.5 } },
  { label: 'amt_iso: ticker + volatilityDrag short-circuit', tool: 'amt_iso_optimize', args: { ...AMT, ticker: 'NVDA', volatilityDrag: 0.2 } },
  { label: 'nso: ticker + haircut short-circuit', tool: 'nso_calculate', args: { ...NSO, ticker: 'AAPL', haircut: 0.2 } },
  { label: 'rsu: ticker + haircut short-circuit', tool: 'rsu_sell_vs_hold', args: { ...RSU, ticker: 'MSFT', haircut: 0.2 } },
  { label: 'protective_put: explicit volatility beside a ticker', tool: 'protective_put_price', args: { ...PUT, ticker: 'NVDA', volatility: 0.35 } },
  { label: 'protective_put: no ticker (sector default)', tool: 'protective_put_price', args: PUT },
  { label: 'qsbs: no volatility path exists', tool: 'qsbs_check', args: QSBS },
  { label: 'qsbs: ticker passed anyway', tool: 'qsbs_check', args: { ...QSBS, ticker: 'NVDA' } },
  { label: 'rsu_lot_optimize: ticker passed anyway', tool: 'rsu_lot_optimize', args: { ...LOTS, ticker: 'NVDA' } },
  { label: 'equity_funding: per-stack ticker resolves GROWTH only', tool: 'equity_funding_plan', args: FUNDING },
  { label: 'equity_funding: top-level ticker passed anyway', tool: 'equity_funding_plan', args: { ...FUNDING, ticker: 'NVDA' } },
  { label: 'amt_iso: malformed args (array)', tool: 'amt_iso_optimize', args: [1, 2, 3] },
  { label: 'amt_iso: malformed args (null)', tool: 'amt_iso_optimize', args: null },
  { label: 'unknown tool name', tool: 'not_a_tool', args: { ticker: 'NVDA' } },
];

// Same parser, same input, once cold and once warm. Outcome is the resolved
// input or the thrown message; either is compared verbatim.
function outcome(tool: string, args: unknown): string {
  const parse = PARSERS[tool];
  if (!parse) return 'no-such-tool';
  try {
    return `ok:${JSON.stringify(parse(args))}`;
  } catch (err) {
    return `throw:${err instanceof Error ? err.message : String(err)}`;
  }
}

function coldVsWarm(tool: string, args: unknown): { cold: string; warm: string } {
  clearVols();
  const cold = outcome(tool, args);
  seedFreshVols();
  const warm = outcome(tool, args);
  return { cold, warm };
}

describe('mayResolveVolFromTicker is behaviour-preserving (the property)', () => {
  for (const c of CASES) {
    it(`${c.label}: predicate false => cold memo and warm memo agree`, () => {
      if (mayResolveVolFromTicker(c.tool, c.args)) return; // covered by the teeth test below
      const { cold, warm } = coldVsWarm(c.tool, c.args);
      expect(warm).toBe(cold);
    });
  }

  // Both spellings reach the same verdict: REST gates on the slug, everything
  // else on the tool name. A slug missing from the table would silently make
  // REST the only surface that stopped resolving tickers.
  for (const c of CASES) {
    const slug = REST_SLUG[c.tool];
    if (!slug) continue;
    it(`${c.label}: the REST slug "${slug}" agrees with the tool name`, () => {
      expect(mayResolveVolFromTicker(slug, c.args)).toBe(mayResolveVolFromTicker(c.tool, c.args));
    });
  }
});

// The property above is only meaningful if warming CAN change an outcome. If
// it never could, every case would pass vacuously - and a predicate hardcoded
// to false would look correct. These are the teeth.
describe('the property has teeth: warming changes these outcomes', () => {
  const RESOLVING: Case[] = [
    { label: 'amt_iso', tool: 'amt_iso_optimize', args: { ...AMT, ticker: 'NVDA' } },
    { label: 'nso', tool: 'nso_calculate', args: { ...NSO, ticker: 'AAPL' } },
    { label: 'rsu', tool: 'rsu_sell_vs_hold', args: { ...RSU, ticker: 'MSFT' } },
    { label: 'concentration', tool: 'concentration_analyze', args: { ...CONC, ticker: 'NVDA' } },
    { label: 'protective_put', tool: 'protective_put_price', args: { ...PUT, ticker: 'NVDA' } },
  ];
  for (const c of RESOLVING) {
    it(`${c.label}: cold and warm differ, and the predicate says so`, () => {
      expect(mayResolveVolFromTicker(c.tool, c.args)).toBe(true);
      const { cold, warm } = coldVsWarm(c.tool, c.args);
      expect(warm).not.toBe(cold);
    });
  }
});

// Asserted directly, because skipping a warm that was never needed cannot be
// observed by a behaviour test - a predicate hardcoded to `true` is invisible
// to everything above.
describe('the gate actually says false where the win is', () => {
  it('is false for a tool with no ticker -> sigma path, even carrying a ticker', () => {
    expect(mayResolveVolFromTicker('qsbs_check', { ...QSBS, ticker: 'NVDA' })).toBe(false);
    expect(mayResolveVolFromTicker('qsbs', { ...QSBS, ticker: 'NVDA' })).toBe(false);
    expect(mayResolveVolFromTicker('rsu_lot_optimize', { ...LOTS, ticker: 'NVDA' })).toBe(false);
    expect(mayResolveVolFromTicker('equity_funding_plan', { ...FUNDING, ticker: 'NVDA' })).toBe(false);
  });

  it('is false when the caller supplied volatility explicitly', () => {
    expect(mayResolveVolFromTicker('amt_iso_optimize', { ...AMT, ticker: 'NVDA', volatility: 0.5 })).toBe(false);
    expect(mayResolveVolFromTicker('protective_put_price', { ...PUT, ticker: 'NVDA', volatility: 0.35 })).toBe(false);
    expect(mayResolveVolFromTicker('concentration_analyze', { ...CONC, ticker: 'NVDA', volatility: 0.4 })).toBe(false);
  });

  it('is false with no top-level ticker, and for junk payloads', () => {
    expect(mayResolveVolFromTicker('amt_iso_optimize', { ...AMT, volatility: 0.5 })).toBe(false);
    expect(mayResolveVolFromTicker('amt_iso_optimize', null)).toBe(false);
    expect(mayResolveVolFromTicker('amt_iso_optimize', [1, 2, 3])).toBe(false);
    expect(mayResolveVolFromTicker('amt_iso_optimize', 'nope')).toBe(false);
    expect(mayResolveVolFromTicker('not_a_tool', { ticker: 'NVDA' })).toBe(false);
  });

  it('is false for the drag short-circuits, true for concentration despite one', () => {
    expect(mayResolveVolFromTicker('amt_iso_optimize', { ...AMT, ticker: 'NVDA', volatilityDrag: 0.2 })).toBe(false);
    expect(mayResolveVolFromTicker('nso_calculate', { ...NSO, ticker: 'AAPL', haircut: 0.2 })).toBe(false);
    expect(mayResolveVolFromTicker('rsu_sell_vs_hold', { ...RSU, ticker: 'MSFT', haircut: 0.2 })).toBe(false);
    // Not a short-circuit here: the hedge-pricing sigma is a separate read.
    expect(mayResolveVolFromTicker('concentration_analyze', { ...CONC, ticker: 'NVDA', volatilityDrag: 0.2 })).toBe(true);
  });

  it('a prototype-polluting key cannot masquerade as a covered tool', () => {
    expect(mayResolveVolFromTicker('toString', { ticker: 'NVDA' })).toBe(false);
    expect(mayResolveVolFromTicker('constructor', { ticker: 'NVDA' })).toBe(false);
  });
});

describe('A2A: partsMayResolveVol', () => {
  const dataPart = (data: unknown): A2APart[] => [{ kind: 'data', data }];

  it('is true for a skill call that needs the lookup', () => {
    expect(partsMayResolveVol(dataPart({ skill: 'amt_iso_optimize', input: { ...AMT, ticker: 'NVDA' } }))).toBe(true);
  });

  it('is false for free text: it routes to a pointer and never parses', () => {
    expect(partsMayResolveVol([{ kind: 'text', text: 'should I exercise my ISOs on NVDA?' }])).toBe(false);
  });

  it('is false for an unknown or missing skill, and for a non-vol skill', () => {
    expect(partsMayResolveVol(dataPart({ input: { ticker: 'NVDA' } }))).toBe(false);
    expect(partsMayResolveVol(dataPart({ skill: 'nope', input: { ticker: 'NVDA' } }))).toBe(false);
    expect(partsMayResolveVol(dataPart({ skill: 'qsbs_check', input: { ...QSBS, ticker: 'NVDA' } }))).toBe(false);
  });

  it('is false when the skill call carries its own volatility', () => {
    expect(
      partsMayResolveVol(dataPart({ skill: 'amt_iso_optimize', input: { ...AMT, ticker: 'NVDA', volatility: 0.5 } })),
    ).toBe(false);
  });
});
