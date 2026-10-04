// AlphaLatitude Inc. © 2026
//
// Disclosed market-average fallback for a missing growth assumption.
// Before 2026-10-04 an omitted expectedGrowth / expectedSalePrice /
// expectedPositionReturn / expectedAnnualGrowth ended the call with "ask the
// user" (~260 calls in 30 days). Now every tool surface that can disclose it
// answers at the S&P 500 trailing average and says so; nothing assumes
// silently, and Poe (a person is right there) still asks.

import { describe, expect, it } from 'vitest';
import {
  collectAssumptions,
  parseEquityFundingInput,
  parseNsoInput,
  runWithAssumptions,
  withoutAssumptions,
} from '../functions/_lib/calc-parsers';
import { computeNsoResult } from '@/lib/calc/nso';
import { getTrailingReturn } from '../lib/data/trailing-returns';
import { SKILLS } from '../functions/_lib/a2a';
import { onRequest as nsoRest } from '../functions/api/v1/nso';

const NSO = {
  shares: 1000, strike: 5, currentPrice: 50, ordinaryIncome: 200000, filingStatus: 'single',
  stateCode: 'CA', stillEmployed: true, holdYears: 3, expectedMarketReturn: 0.07, holdFunding: 'cash',
  volatility: 0.3,
};
const run = runWithAssumptions(parseNsoInput, computeNsoResult);
type Disclosed = { assumptions?: Array<{ field: string; value: number; annualRate: number; reason: string; basis: string }>; assumptionNotice?: string };

describe('the fallback only fires where it can be disclosed', () => {
  it('an unarmed parse still errors', () => {
    expect(() => parseNsoInput(NSO)).toThrow(/field "expectedSalePrice" required/);
  });

  it('withoutAssumptions keeps the error even inside a tool runner (Poe)', () => {
    expect(() => withoutAssumptions(() => run(NSO))).toThrow(/field "expectedSalePrice" required/);
  });
});

describe('what it assumes, and how it says so', () => {
  const spy3y = getTrailingReturn('SPY', 3)!;

  it('expectedSalePrice: projects currentPrice at the S&P average, records the price and the rate', () => {
    const r = run(NSO) as Disclosed & { hold: { effectiveSalePrice: number } };
    expect(r.assumptions).toHaveLength(1);
    const a = r.assumptions![0];
    expect(a.field).toBe('expectedSalePrice');
    expect(a.annualRate).toBeCloseTo(spy3y, 10);
    expect(a.value).toBeCloseTo(50 * (1 + spy3y) ** 3, 8);
    expect(a.reason).toBe('was not provided');
    expect(r.assumptionNotice).toMatch(/^Assumption: expectedSalePrice was not provided, so this answer assumes the S&P 500 trailing average \(\d+\.\d%\/yr over 3y\)\..*tell the user/);
  });

  it('a ticker we have no growth for is named as the reason', () => {
    const r = run({ ...NSO, ticker: 'ZZZQ' }) as Disclosed;
    expect(r.assumptions![0].reason).toBe('could not be derived from ticker "ZZZQ" (no trailing returns for it)');
  });

  it('an explicit value is used as-is, with no assumptions field', () => {
    const r = run({ ...NSO, expectedSalePrice: 80 }) as Disclosed;
    expect(r.assumptions).toBeUndefined();
    expect(r.assumptionNotice).toBeUndefined();
  });

  it('an invalid value is still an error, not a fallback', () => {
    expect(() => run({ ...NSO, expectedSalePrice: 'lots' })).toThrow(/expectedSalePrice/);
  });

  it('ticker "market" keeps its own explanatory error (#262)', () => {
    expect(() => run({ ...NSO, ticker: 'market' })).toThrow(/"market" is not a ticker/);
  });

  it('equity funding labels the stack it filled', () => {
    const { assumptions } = collectAssumptions(() =>
      parseEquityFundingInput(
        {
          targetAfterTax: 300000, targetDate: '2028-06-01', ordinaryIncome: 250000, filingStatus: 'single', stateCode: 'CA',
          stacks: [{ currentPrice: 100, volatility: 0.4, lots: [{ shares: 5000, costBasisPerShare: 20, acquisitionDate: '2023-01-15' }] }],
        },
        new Date('2026-10-04T12:00:00Z'),
      ),
    );
    expect(assumptions.map((a) => a.field)).toEqual(['stacks[0].expectedAnnualGrowth']);
  });
});

describe('every disclosing surface carries it', () => {
  it('A2A skill', () => {
    const skill = SKILLS.find((s) => s.id === 'nso_calculate')!;
    expect((skill.run(NSO) as Disclosed).assumptions?.[0].field).toBe('expectedSalePrice');
  });

  it('REST /api/v1/nso', async () => {
    const res = await nsoRest({
      request: new Request('http://localhost/api/v1/nso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(NSO) }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Disclosed };
    expect(body.result.assumptions?.[0].field).toBe('expectedSalePrice');
    expect(body.result.assumptionNotice).toMatch(/tell the user/);
  });
});
