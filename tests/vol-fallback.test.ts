// AlphaLatitude Inc. © 2026
//
// Missing volatility gets a disclosed market-median placeholder instead of a
// "volatility required" error, the same rule as missing growth (#268), and a
// null field reads as "not provided".
//
// Why: a startup employee planning an ISO exercise has no ticker and no idea
// what an implied volatility is, so "pass an annualized sigma" ended the
// conversation. In production the most frequent remaining tool-call error after
// #268 was exactly that, on every single-sigma tool. And OpenAI strict-mode
// callers send null for each optional field they do not know, which failed as
// "must be a finite number" before any default or fallback could run.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectAssumptions,
  mayAssumeVol,
  mayResolveVolFromTicker,
  parseConcentrationInput,
  parseEquityFundingInput,
  parseNsoInput,
  runWithAssumptions,
  warmForCall,
  withoutAssumptions,
} from '../functions/_lib/calc-parsers';
import { computeNsoResult } from '@/lib/calc/nso';
import { getMarketMedianVol, MARKET_VOL_MIN_ENTRIES, __setVolSnapshotForTests } from '../lib/data/live-vols';
import { cutoffSeconds, volsArtifact, FIXTURE_VOLS } from './helpers/live-vols-fixture';

// A document wide enough to be a market (MARKET_VOL_MIN_ENTRIES entries):
// sigmas 0.20, 0.21, ... so the median is known exactly.
function marketDoc(count: number, extra: Record<string, number> = {}) {
  const vols: Record<string, number> = { ...extra };
  for (let i = 0; i < count; i++) vols[`T${String(i).padStart(3, '0')}`] = Number((0.2 + i * 0.01).toFixed(2));
  return volsArtifact(cutoffSeconds(), vols);
}
const medianOf = (count: number) => (count % 2 ? 0.2 + ((count - 1) / 2) * 0.01 : 0.2 + (count / 2 - 0.5) * 0.01);

const NSO = {
  shares: 1000, strike: 5, currentPrice: 50, expectedSalePrice: 60, ordinaryIncome: 200000,
  filingStatus: 'single', stateCode: 'CA', stillEmployed: true, holdYears: 3,
  expectedMarketReturn: 0.07, holdFunding: 'cash',
};
const run = runWithAssumptions(parseNsoInput, computeNsoResult);
type Disclosed = { assumptions?: Array<{ field: string; value: number; reason: string; basis: string }>; assumptionNotice?: string };

describe('getMarketMedianVol', () => {
  it('is the median sigma across every fresh entry, with the count', () => {
    __setVolSnapshotForTests(marketDoc(61));
    const m = getMarketMedianVol()!;
    expect(m.n).toBe(61);
    expect(m.sigma).toBeCloseTo(medianOf(61), 10);
  });

  it('averages the middle pair on an even count', () => {
    __setVolSnapshotForTests(marketDoc(60));
    expect(getMarketMedianVol()!.sigma).toBeCloseTo(medianOf(60), 10);
  });

  it('is null below the minimum: a handful of stocks is not the market', () => {
    __setVolSnapshotForTests(marketDoc(MARKET_VOL_MIN_ENTRIES - 1));
    expect(getMarketMedianVol()).toBeNull();
  });

  it('is null when the document failed to load', () => {
    __setVolSnapshotForTests(null);
    expect(getMarketMedianVol()).toBeNull();
  });

  it('skips stale entries, as the per-ticker reader does', () => {
    const stale = cutoffSeconds() - 86_400 * 3;
    const doc = marketDoc(MARKET_VOL_MIN_ENTRIES);
    (doc.vols as Record<string, { atmIV1y: number; asOf: number }>).T000.asOf = stale;
    __setVolSnapshotForTests(doc);
    expect(getMarketMedianVol()).toBeNull(); // one entry short of the minimum now
  });
});

describe('the volatility fallback', () => {
  beforeEach(() => __setVolSnapshotForTests(marketDoc(61, FIXTURE_VOLS)));

  it('answers with the market median, disclosed, when volatility is not provided', () => {
    const out = run(NSO) as Disclosed;
    const a = out.assumptions?.find((x) => x.field === 'volatility');
    expect(a).toBeDefined();
    expect(a!.value).toBeCloseTo(getMarketMedianVol()!.sigma, 10);
    expect(a!.reason).toBe('was not provided');
    expect(a!.basis).toMatch(/median implied volatility of the 66 public companies OptionsAhoy covers/);
    expect(out.assumptionNotice).toMatch(/volatility was not provided, so this answer assumes the median implied volatility/);
  });

  it('names the ticker when one was given but has no current sigma', () => {
    const out = run({ ...NSO, ticker: 'ZZZZ' }) as Disclosed;
    expect(out.assumptions?.find((x) => x.field === 'volatility')?.reason).toMatch(
      /could not be resolved for ticker "ZZZZ" \(no current implied volatility for it in OptionsAhoy's data or its option chain\)/,
    );
  });

  it('uses a covered ticker\'s own sigma and assumes nothing', () => {
    const out = run({ ...NSO, ticker: 'AAPL' }) as Disclosed;
    expect(out.assumptions?.some((x) => x.field === 'volatility') ?? false).toBe(false);
  });

  it('keeps the error where nothing can disclose it (Poe asks the user)', () => {
    expect(() => withoutAssumptions(() => run(NSO))).toThrow(/field "volatility" required/);
  });

  it('keeps the error when the market median is unavailable', () => {
    __setVolSnapshotForTests(marketDoc(MARKET_VOL_MIN_ENTRIES - 1));
    expect(() => run(NSO)).toThrow(/field "volatility" required/);
  });

  it('concentration prices its hedge at the same assumed sigma, recorded once', () => {
    const { value, assumptions } = collectAssumptions(() =>
      parseConcentrationInput({
        positionValue: 500000, costBasis: 100000, acquisitionDate: '2020-01-15', sector: 'tech_software',
        stateCode: 'CA', filingStatus: 'single', ordinaryIncome: 250000, totalAssets: 1500000,
        expectedPositionReturn: 0.1,
      }),
    );
    const vols = assumptions.filter((a) => a.field === 'volatility');
    expect(vols).toHaveLength(1);
    expect(value.volatility).toBeCloseTo(vols[0].value, 10);
  });

  it('warms the vols document for a call that may need the median', () => {
    __setVolSnapshotForTests(undefined); // cold
    expect(mayAssumeVol('amt_iso_optimize', { shares: 1 })).toBe(true);
    expect(warmForCall('amt_iso_optimize', { shares: 1 })).not.toBeNull();
  });

  it('does not warm for it when the caller gave a sigma, a drag, or a ticker', () => {
    expect(mayAssumeVol('nso_calculate', { volatility: 0.3 })).toBe(false);
    expect(mayAssumeVol('nso_calculate', { haircut: 0.1 })).toBe(false);
    expect(mayAssumeVol('nso_calculate', { ticker: 'AAPL' })).toBe(false); // the ticker warm covers it
    expect(mayAssumeVol('protective_put_price', {})).toBe(false); // has its own sector default
  });
});

describe('a null field means "not provided"', () => {
  beforeEach(() => __setVolSnapshotForTests(marketDoc(61, FIXTURE_VOLS)));

  it('reaches the growth fallback instead of "must be a finite number"', () => {
    const out = run({ ...NSO, expectedSalePrice: null, volatility: 0.3 }) as Disclosed;
    expect(out.assumptions?.some((x) => x.field === 'expectedSalePrice')).toBe(true);
  });

  it('reaches the volatility fallback the same way', () => {
    const out = run({ ...NSO, volatility: null }) as Disclosed;
    expect(out.assumptions?.some((x) => x.field === 'volatility')).toBe(true);
  });

  it('says "required" for a required field sent as null, or not sent at all', () => {
    const { shares: _s, ...noShares } = NSO;
    expect(() => run({ ...NSO, shares: null })).toThrow('field "shares" required (a number)');
    expect(() => run(noShares)).toThrow('field "shares" required (a number)');
    // A value that is present but wrong keeps saying what is wrong with it.
    expect(() => run({ ...NSO, shares: 'lots' })).toThrow('field "shares" must be a finite number');
  });

  it('lets a null volatility beside a ticker warm and resolve the ticker\'s sigma', () => {
    expect(mayResolveVolFromTicker('nso_calculate', { ticker: 'AAPL', volatility: null })).toBe(true);
    const out = run({ ...NSO, ticker: 'AAPL', volatility: null }) as Disclosed;
    expect(out.assumptions?.some((x) => x.field === 'volatility') ?? false).toBe(false);
  });
});

describe('a deadline in the past', () => {
  it('names today, so a model with a stale calendar can correct the date', () => {
    const today = new Date('2026-10-07T12:00:00Z');
    expect(() =>
      parseEquityFundingInput(
        {
          targetAfterTax: 100000, targetDate: '2026-06-30', ordinaryIncome: 200000, filingStatus: 'single',
          stateCode: 'CA', stacks: [{ currentPrice: 100, expectedAnnualGrowth: 0.1, lots: [{ shares: 2000, costBasisPerShare: 20, acquisitionDate: '2022-01-15' }] }],
        },
        today,
      ),
    ).toThrow('field "targetDate" must be today or later: the deadline is in the past (today is 2026-10-07).');
  });
});
