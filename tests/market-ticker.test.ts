// AlphaLatitude Inc. © 2026
//
// `ticker: "market"` (prod, week to 2026-09-18): the caller wants a
// market-average assumption. That exists on the growth fields, not on
// `ticker`, and it is deliberately NOT accepted as a ticker: `ticker` also
// sets volatility, and the index's sigma would understate a single stock's
// risk. The error must name the field that takes "market" and ask for
// volatility outright, rather than calling it an uncovered symbol.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAmtIsoInput,
  parseConcentrationInput,
  parseEquityFundingInput,
  parseNsoInput,
  parseRsuInput,
  warmForCall,
} from '../functions/_lib/calc-parsers';
import { seedFreshVols, clearVols } from './helpers/live-vols-fixture';
import { stubFetch, jsonResponse } from './helpers/stub-fetch';

const AMT = {
  shares: 10000, strike: 2, fmv: 200, filingStatus: 'married_joint', ordinaryIncome: 400000,
  stateCode: 'CA', carryforwardCredit: 0, horizon: 4, cashReturnRate: 0.05,
  grantDate: '2022-01-15', hasLeftCompany: false, terminationDate: null,
};
const NSO = {
  shares: 1000, strike: 5, currentPrice: 50, ordinaryIncome: 200000, filingStatus: 'single',
  stateCode: 'CA', stillEmployed: true, holdYears: 3, expectedMarketReturn: 0.07, holdFunding: 'cash',
};
const RSU = {
  shares: 500, currentPrice: 80, ordinaryIncome: 200000, filingStatus: 'single',
  stateCode: 'CA', stillEmployed: true, holdYears: 2, expectedMarketReturn: 0.07,
};
const CONC = {
  positionValue: 1000000, costBasis: 200000, acquisitionDate: '2022-01-15', sector: 'tech_software',
  stateCode: 'CA', filingStatus: 'single', ordinaryIncome: 250000, totalAssets: 1500000,
  expectedMarketReturn: 0.07,
};
const FUNDING = {
  targetAfterTax: 500000, targetDate: '2027-08-19', ordinaryIncome: 250000, filingStatus: 'single', stateCode: 'CA',
  stacks: [{ ticker: 'market', currentPrice: 100, lots: [{ shares: 10000, costBasisPerShare: 20, acquisitionDate: '2023-01-15' }] }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearVols();
});

const NOT_A_TICKER = /"market" is not a ticker/;

describe('growth fields name the field that takes "market"', () => {
  it.each([
    ['nso_calculate', () => parseNsoInput({ ...NSO, ticker: 'market' }), 'expectedSalePrice'],
    ['rsu_sell_vs_hold', () => parseRsuInput({ ...RSU, ticker: 'Market' }), 'expectedSalePrice'],
    ['amt_iso_optimize', () => parseAmtIsoInput({ ...AMT, ticker: 'market', volatility: 0.4 }), 'expectedGrowth'],
    ['concentration_analyze', () => parseConcentrationInput({ ...CONC, ticker: 'market', volatility: 0.4 }), 'expectedPositionReturn'],
    ['equity_funding_plan', () => parseEquityFundingInput(FUNDING, new Date('2026-08-19T12:00:00Z')), 'stacks[0].expectedAnnualGrowth'],
  ])('%s', (_tool, run, field) => {
    let msg = '';
    try { run(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(NOT_A_TICKER);
    expect(msg).toContain(`pass "${field}": "market"`);
    expect(msg).toContain('pass "volatility" explicitly');
    expect(msg).not.toMatch(/not in our trailing-returns table/);
  });
});

describe('the volatility path says the same, not "not covered"', () => {
  it('when growth is already "market", volatility is what is missing', () => {
    seedFreshVols();
    expect(() => parseNsoInput({ ...NSO, ticker: 'market', expectedSalePrice: 'market' }))
      .toThrow(/field "volatility" required: "market" is not a ticker/);
    expect(() => parseConcentrationInput({ ...CONC, ticker: 'market', expectedPositionReturn: 'market' }))
      .toThrow(/field "volatility" required: "market" is not a ticker/);
  });

  it('explicit growth and volatility make ticker "market" harmless', () => {
    expect(() => parseNsoInput({ ...NSO, ticker: 'market', expectedSalePrice: 'market', volatility: 0.4 })).not.toThrow();
  });
});

it('never spends a chain fetch on it', async () => {
  const spy = stubFetch(() => jsonResponse({ schemaV: 1, generatedAt: '', vols: {} }));
  await warmForCall('nso_calculate', { ...NSO, ticker: 'market' });
  expect((spy.mock.calls as unknown as [string][]).map(([u]) => u).filter((u) => u.includes('/chains/fetch/'))).toEqual([]);
});
