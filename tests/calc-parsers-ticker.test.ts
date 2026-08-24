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

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  parseAmtIsoInput,
  parseConcentrationInput,
  parseNsoInput,
  parseProtectivePutInput,
  parseRsuInput,
} from '../functions/_lib/calc-parsers';
import { getTrailingReturn, hasTrailingReturn, isKnownTicker } from '../lib/data/trailing-returns';
import returnsData from '../lib/data/trailing-returns.json';
import { FIXTURE_VOLS, clearVols, seedFreshVols } from './helpers/live-vols-fixture';
import { SECTOR_STATS } from '../lib/markets/sector-stats';
import { lognormalHaircut } from '@/lib/calc/volatility-drag';

// Base fixtures with EVERY required field except the growth-rate ones —
// each test fills in the growth path it's exercising.
const AMT_ISO_BASE = {
  shares: 5000,
  strike: 4,
  fmv: 90,
  volatility: 0.3,
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
  volatility: 0.3,
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
  volatility: 0.3,
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
  volatility: 0.3,
};

// Volatility now resolves from the PUBLISHED artifact under a last-close
// freshness gate, not from a table bundled with the package. Seed a fixture
// document before every test so these stay hermetic: the suite must pass
// before the producer is deployed, and must never assert against whatever the
// live CDN happens to be serving. The dedicated gate/fetch behaviour lives in
// live-vols.test.ts; here we only need a covered symbol to exist.
beforeEach(() => seedFreshVols());
afterAll(() => clearVols());

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

describe('parseAmtIsoInput — volatility -> drag derivation', () => {
  it('derives volatilityDrag from annualized sigma over the planning horizon', () => {
    const sigma = 0.72;
    const out = parseAmtIsoInput({ ...AMT_ISO_BASE, expectedGrowth: 0.17, volatility: sigma });
    expect(out.volatilityDrag).toBeCloseTo(lognormalHaircut(sigma, AMT_ISO_BASE.horizon), 10);
  });

  it('throws when volatility is missing', () => {
    const { volatility: _v, ...NO_VOL } = AMT_ISO_BASE;
    expect(() => parseAmtIsoInput({ ...NO_VOL, expectedGrowth: 0.17 })).toThrow(
      /volatility.*required/i,
    );
  });
});

describe('parseNsoInput — volatility -> haircut derivation', () => {
  it('derives haircut from sigma over holdYears', () => {
    const sigma = 0.5;
    const out = parseNsoInput({
      ...NSO_BASE,
      expectedSalePrice: 100,
      volatility: sigma,
    });
    expect(out.haircut).toBeCloseTo(lognormalHaircut(sigma, NSO_BASE.holdYears), 10);
  });
});

describe('parseRsuInput — volatility -> haircut derivation', () => {
  it('derives haircut from sigma over holdYears', () => {
    const sigma = 0.4;
    const out = parseRsuInput({
      ...RSU_BASE,
      expectedSalePrice: 100,
      volatility: sigma,
    });
    expect(out.haircut).toBeCloseTo(lognormalHaircut(sigma, RSU_BASE.holdYears), 10);
  });
});

describe('parseConcentrationInput — volatility -> drag derivation', () => {

  it('derives volatilityDrag from sigma over the 3y concentration horizon', () => {
    const sigma = 0.55;
    const out = parseConcentrationInput({
      ...CONCENTRATION_BASE,
      expectedPositionReturn: 0.12,
      volatility: sigma,
    });
    expect(out.volatilityDrag).toBeCloseTo(lognormalHaircut(sigma, 3), 10);
    expect(out.volatility).toBe(sigma);
  });
});

// Ticker → ATM 1y IV resolution.
// Mirrors the trailing-returns ticker tests above: explicit volatility wins;
// ticker substitutes when no explicit sigma; unknown ticker throws for the
// drag-bearing tools, falls through to sector default for protective put.

describe('parseAmtIsoInput — ticker → sigma resolution', () => {
  it('substitutes the ticker\'s ATM 1y IV when volatility is omitted', () => {
    const { volatility: _v, ...NO_VOL } = AMT_ISO_BASE;
    const out = parseAmtIsoInput({ ...NO_VOL, expectedGrowth: 0.17, ticker: 'NVDA' });
    const sigma = FIXTURE_VOLS.NVDA;
    expect(out.volatilityDrag).toBeCloseTo(lognormalHaircut(sigma, AMT_ISO_BASE.horizon), 10);
  });

  it('prefers explicit volatility over ticker', () => {
    const out = parseAmtIsoInput({
      ...AMT_ISO_BASE,
      expectedGrowth: 0.17,
      ticker: 'NVDA',
      volatility: 0.99,
    });
    expect(out.volatilityDrag).toBeCloseTo(lognormalHaircut(0.99, AMT_ISO_BASE.horizon), 10);
  });

  it('throws when ticker is set but unknown', () => {
    const { volatility: _v, ...NO_VOL } = AMT_ISO_BASE;
    expect(() => parseAmtIsoInput({ ...NO_VOL, expectedGrowth: 0.17, ticker: 'BOGUS' })).toThrow(
      /implied-vol table.*MUST NOT invent/i,
    );
  });
});

describe('parseConcentrationInput — ticker → sigma resolution', () => {
  it('substitutes the ticker\'s ATM 1y IV when volatility is omitted', () => {
    const { volatility: _v, ...NO_VOL } = CONCENTRATION_BASE;
    const out = parseConcentrationInput({
      ...NO_VOL,
      expectedPositionReturn: 0.10,
      ticker: 'NVDA',
    });
    const sigma = FIXTURE_VOLS.NVDA;
    expect(out.volatility).toBe(sigma);
  });
});

describe('parseNsoInput / parseRsuInput — ticker → sigma resolution', () => {
  it('NSO substitutes the ticker IV when volatility is omitted', () => {
    const { volatility: _v, ...NO_VOL } = NSO_BASE;
    const out = parseNsoInput({ ...NO_VOL, ticker: 'AAPL', expectedSalePrice: 80 });
    const sigma = FIXTURE_VOLS.AAPL;
    expect(out.haircut).toBeCloseTo(lognormalHaircut(sigma, NSO_BASE.holdYears), 10);
  });

  it('RSU substitutes the ticker IV when volatility is omitted', () => {
    const { volatility: _v, ...NO_VOL } = RSU_BASE;
    const out = parseRsuInput({ ...NO_VOL, ticker: 'MSFT', expectedSalePrice: 100 });
    const sigma = FIXTURE_VOLS.MSFT;
    expect(out.haircut).toBeCloseTo(lognormalHaircut(sigma, RSU_BASE.holdYears), 10);
  });
});

describe('parseProtectivePutInput — ticker → sigma resolution', () => {
  const PUT_BASE = {
    positionValue: 100000,
    sector: 'tech_software',
    protectionLevel: 0.2,
    tenorYears: 1,
  };

  it('uses the ticker IV when volatility is omitted', () => {
    const out = parseProtectivePutInput({ ...PUT_BASE, ticker: 'NVDA' });
    const sigma = FIXTURE_VOLS.NVDA;
    expect(out.volatility).toBe(sigma);
  });

  it('prefers explicit volatility over ticker', () => {
    const out = parseProtectivePutInput({ ...PUT_BASE, ticker: 'NVDA', volatility: 0.99 });
    expect(out.volatility).toBe(0.99);
  });

  it('falls through to sector default when ticker is unknown (no throw)', () => {
    const out = parseProtectivePutInput({ ...PUT_BASE, ticker: 'BOGUS' });
    expect(out.volatility).toBeCloseTo(SECTOR_STATS.tech_software.annualVol * 1.20, 10);
  });

  it('echoes ticker as tickerLabel when tickerLabel is not provided', () => {
    const out = parseProtectivePutInput({ ...PUT_BASE, ticker: 'NVDA' });
    expect(out.tickerLabel).toBe('NVDA');
  });

  it('prefers explicit tickerLabel over ticker for display', () => {
    const out = parseProtectivePutInput({ ...PUT_BASE, ticker: 'NVDA', tickerLabel: 'Nvidia' });
    expect(out.tickerLabel).toBe('Nvidia');
  });
});

// The "market" sentinel: a growth/return/sale-price field set to the literal
// string "market" resolves to the SPY trailing blend at the relevant horizon —
// the sanctioned no-view path that replaces the old dead-end error. Each test
// fails on the pre-sentinel code (which rejected any string via p.num).
describe('"market" sentinel for growth fields', () => {
  it('amt_iso: expectedGrowth "market" resolves to the SPY blend at the horizon', () => {
    const out = parseAmtIsoInput({ ...AMT_ISO_BASE, expectedGrowth: 'market' });
    expect(out.expectedGrowth).toBe(getTrailingReturn('SPY', AMT_ISO_BASE.horizon));
  });

  it('is case- and whitespace-insensitive', () => {
    const out = parseAmtIsoInput({ ...AMT_ISO_BASE, expectedGrowth: ' Market ' });
    expect(out.expectedGrowth).toBe(getTrailingReturn('SPY', AMT_ISO_BASE.horizon));
  });

  it('concentration: expectedPositionReturn "market" resolves to the SPY blend', () => {
    const out = parseConcentrationInput({ ...CONCENTRATION_BASE, expectedPositionReturn: 'market' });
    expect(out.expectedPositionReturn).toBe(getTrailingReturn('SPY', 3));
  });

  it('nso: expectedSalePrice "market" projects currentPrice at the SPY blend', () => {
    const out = parseNsoInput({ ...NSO_BASE, expectedSalePrice: 'market' });
    const spy = getTrailingReturn('SPY', NSO_BASE.holdYears)!;
    expect(out.expectedSalePrice).toBeCloseTo(
      NSO_BASE.currentPrice * Math.pow(1 + spy, NSO_BASE.holdYears),
      6,
    );
  });

  it('rsu: expectedSalePrice "market" projects currentPrice at the SPY blend', () => {
    const out = parseRsuInput({ ...RSU_BASE, expectedSalePrice: 'market' });
    const spy = getTrailingReturn('SPY', RSU_BASE.holdYears)!;
    expect(out.expectedSalePrice).toBeCloseTo(
      RSU_BASE.currentPrice * Math.pow(1 + spy, RSU_BASE.holdYears),
      6,
    );
  });

  it('"market" wins over a ticker on the same call (explicit field beats shortcut)', () => {
    const out = parseAmtIsoInput({ ...AMT_ISO_BASE, expectedGrowth: 'market', ticker: 'NVDA' });
    expect(out.expectedGrowth).toBe(getTrailingReturn('SPY', AMT_ISO_BASE.horizon));
  });

  it('any other string is still rejected as a non-number', () => {
    expect(() => parseAmtIsoInput({ ...AMT_ISO_BASE, expectedGrowth: 'bullish' })).toThrow();
  });

  it('the no-value error advertises the "market" option', () => {
    expect(() => parseAmtIsoInput(AMT_ISO_BASE)).toThrow(/"market"/);
  });
});

describe('recent-IPO tickers get a distinct error (not "not in our table")', () => {
  // A table key whose 5y AND 10y returns are both null (recent listing).
  // Skipped if the current ETL snapshot has no such symbol.
  const recentIpo = Object.keys(returnsData.tickers).find(
    (t) => isKnownTicker(t) && !hasTrailingReturn(t),
  );

  it.skipIf(!recentIpo)('says "listed too recently", names the field and the market option', () => {
    expect(() => parseAmtIsoInput({ ...AMT_ISO_BASE, ticker: recentIpo })).toThrow(
      /listed too recently.*"market"/s,
    );
  });

  it('unknown symbols still get the "not in our trailing-returns table" error with examples', () => {
    expect(() => parseAmtIsoInput({ ...AMT_ISO_BASE, ticker: 'BOGUS' })).toThrow(
      /not in our trailing-returns table \(covered examples: [A-Z]/,
    );
  });
});

describe('GOOG share-class alias', () => {
  it('resolves GOOG to the same trailing return as GOOGL', () => {
    expect(getTrailingReturn('GOOG', 3)).toEqual(getTrailingReturn('GOOGL', 3));
    expect(getTrailingReturn('goog', 5)).toEqual(getTrailingReturn('GOOGL', 5));
  });

  it('parses concentration input with ticker GOOG without throwing', () => {
    const out = parseConcentrationInput({ ...CONCENTRATION_BASE, ticker: 'GOOG' });
    expect(out.expectedPositionReturn).toBe(getTrailingReturn('GOOGL', 3));
  });
});
