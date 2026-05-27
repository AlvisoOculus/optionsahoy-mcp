// AlphaLatitude Inc. © 2026
//
// Ticker-lookup behavior for the four growth-bearing parsers.
//
// Goals:
//   1. ticker resolves expectedPositionReturn / expectedGrowth /
//      expectedSalePrice / expectedMarketReturn instead of forcing the
//      caller (typically an LLM) to invent one.
//   2. ticker AND explicit field both present → explicit field wins.
//   3. ticker absent AND explicit field absent → throw a clear
//      "ask the user, do not invent" error.
//   4. ticker not in the registry → same error path (model is told to
//      pass an explicit value or use a covered ticker).
//   5. expectedMarketReturn defaults to SPY trailing CAGR for the
//      relevant horizon even without a ticker.

import { describe, it, expect } from 'vitest';
import {
  parseAmtIsoInput,
  parseConcentrationInput,
  parseNsoInput,
  parseProtectivePutInput,
  parseRsuInput,
} from '../functions/_lib/calc-parsers';
import { getTrailingReturn } from '../lib/data/trailing-returns';
import { SECTOR_STATS } from '../lib/markets/sector-stats';

// Base fixtures with EVERY required field except the growth-rate ones —
// each test fills in the growth path it's exercising.
const AMT_ISO_BASE = {
  shares: 5000,
  strike: 4,
  fmv: 90,
  volatilityDrag: 0.2,
  filingStatus: 'single',
  ordinaryIncome: 250000,
  stateCode: 'CA',
  carryforwardCredit: 0,
  horizon: 4,
  cashReturnRate: 0.05,
  grantDate: '2024-05-20',
  hasLeftCompany: false,
  terminationDate: null,
};

const CONCENTRATION_BASE = {
  positionValue: 400000,
  costBasis: 200000,
  acquisitionDate: '2022-01-15',
  sector: 'tech_software',
  stateCode: 'CA',
  filingStatus: 'single',
  ordinaryIncome: 250000,
  totalAssets: 1000000,
  volatilityDrag: 0.2,
};

const NSO_BASE = {
  shares: 1000,
  strike: 5,
  currentPrice: 50,
  ordinaryIncome: 200000,
  filingStatus: 'single',
  stateCode: 'CA',
  stillEmployed: true,
  holdYears: 3,
  haircut: 0.2,
  holdFunding: 'cash',
};

const RSU_BASE = {
  shares: 500,
  currentPrice: 80,
  ordinaryIncome: 200000,
  filingStatus: 'single',
  stateCode: 'CA',
  stillEmployed: true,
  holdYears: 2,
  haircut: 0.2,
};

describe('parseConcentrationInput — ticker lookup', () => {
  it('resolves expectedPositionReturn from a covered ticker', () => {
    const out = parseConcentrationInput({ ...CONCENTRATION_BASE, ticker: 'NVDA' });
    const expected = getTrailingReturn('NVDA', 3);
    expect(out.expectedPositionReturn).toBe(expected);
  });

  it('defaults expectedMarketReturn to SPY blend for the 3y horizon', () => {
    const out = parseConcentrationInput({ ...CONCENTRATION_BASE, ticker: 'NVDA' });
    const expected = getTrailingReturn('SPY', 3);
    expect(out.expectedMarketReturn).toBe(expected);
  });

  it('prefers explicit expectedPositionReturn over ticker lookup', () => {
    const out = parseConcentrationInput({
      ...CONCENTRATION_BASE,
      ticker: 'NVDA',
      expectedPositionReturn: 0.05,
    });
    expect(out.expectedPositionReturn).toBe(0.05);
  });

  it('throws "ask the user" when neither ticker nor explicit return is set', () => {
    expect(() => parseConcentrationInput(CONCENTRATION_BASE)).toThrow(/MUST NOT invent/i);
  });

  it('throws "ticker not covered" for unknown ticker without explicit return', () => {
    expect(() =>
      parseConcentrationInput({ ...CONCENTRATION_BASE, ticker: 'BOGUS' }),
    ).toThrow(/BOGUS.*trailing-returns table/);
  });
});

describe('parseAmtIsoInput — ticker lookup', () => {
  it('resolves expectedGrowth from a covered ticker at the horizon', () => {
    const out = parseAmtIsoInput({ ...AMT_ISO_BASE, ticker: 'NVDA' });
    const expected = getTrailingReturn('NVDA', AMT_ISO_BASE.horizon);
    expect(out.expectedGrowth).toBe(expected);
  });

  it('prefers explicit expectedGrowth over ticker', () => {
    const out = parseAmtIsoInput({
      ...AMT_ISO_BASE,
      ticker: 'NVDA',
      expectedGrowth: 0.07,
    });
    expect(out.expectedGrowth).toBe(0.07);
  });

  it('throws when expectedGrowth and ticker are both absent', () => {
    expect(() => parseAmtIsoInput(AMT_ISO_BASE)).toThrow(/expectedGrowth.*MUST NOT invent/i);
  });
});

describe('parseNsoInput — ticker lookup', () => {
  it('derives expectedSalePrice from currentPrice × (1 + ticker CAGR)^holdYears', () => {
    const out = parseNsoInput({ ...NSO_BASE, ticker: 'NVDA' });
    const cagr = getTrailingReturn('NVDA', NSO_BASE.holdYears)!;
    const expected = NSO_BASE.currentPrice * Math.pow(1 + cagr, NSO_BASE.holdYears);
    expect(out.expectedSalePrice).toBeCloseTo(expected, 6);
  });

  it('prefers explicit expectedSalePrice over ticker derivation', () => {
    const out = parseNsoInput({
      ...NSO_BASE,
      ticker: 'NVDA',
      expectedSalePrice: 999,
    });
    expect(out.expectedSalePrice).toBe(999);
  });

  it('defaults expectedMarketReturn to SPY blend for holdYears', () => {
    const out = parseNsoInput({ ...NSO_BASE, ticker: 'NVDA' });
    expect(out.expectedMarketReturn).toBe(getTrailingReturn('SPY', NSO_BASE.holdYears));
  });

  it('throws when neither ticker nor expectedSalePrice is set', () => {
    expect(() => parseNsoInput(NSO_BASE)).toThrow(/expectedSalePrice.*MUST NOT invent/i);
  });
});

describe('parseProtectivePutInput — sector-default volatility', () => {
  const PUT_BASE = {
    positionValue: 100000,
    sector: 'tech_software',
    protectionLevel: 0.2,
    tenorYears: 1,
  };

  it('defaults volatility to sector_stats.annualVol × 1.20 when omitted', () => {
    const out = parseProtectivePutInput(PUT_BASE);
    expect(out.volatility).toBeCloseTo(SECTOR_STATS.tech_software.annualVol * 1.20, 10);
  });

  it('prefers explicit volatility over sector default', () => {
    const out = parseProtectivePutInput({ ...PUT_BASE, volatility: 0.55 });
    expect(out.volatility).toBe(0.55);
  });

  it('sector affects the default (semis IV > tech IV)', () => {
    const tech = parseProtectivePutInput(PUT_BASE);
    const semis = parseProtectivePutInput({ ...PUT_BASE, sector: 'semiconductors' });
    expect(semis.volatility).toBeGreaterThan(tech.volatility);
  });
});

describe('parseRsuInput — ticker lookup', () => {
  it('derives expectedSalePrice from currentPrice × (1 + ticker CAGR)^holdYears', () => {
    const out = parseRsuInput({ ...RSU_BASE, ticker: 'AAPL' });
    const cagr = getTrailingReturn('AAPL', RSU_BASE.holdYears)!;
    const expected = RSU_BASE.currentPrice * Math.pow(1 + cagr, RSU_BASE.holdYears);
    expect(out.expectedSalePrice).toBeCloseTo(expected, 6);
  });

  it('throws when neither ticker nor expectedSalePrice is set', () => {
    expect(() => parseRsuInput(RSU_BASE)).toThrow(/expectedSalePrice.*MUST NOT invent/i);
  });
});
