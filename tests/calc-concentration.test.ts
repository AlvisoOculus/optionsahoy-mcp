// AlphaLatitude Inc. © 2026
//
// Regression coverage for the concentration hedging output honoring an
// optional hedgeChoice (audit D3). Before the fix, calculate() ignored
// inputs.hedgeChoice and always returned a hardcoded 1-year 30%-OTM put,
// so the documented hedgeChoice input silently did nothing.

import { describe, it, expect } from 'vitest';
import { calculate, type ConcentrationInputs } from '../lib/calc/concentration';

function input(overrides: Partial<ConcentrationInputs> = {}): ConcentrationInputs {
  return {
    positionValue: 400000,
    costBasis: 100000,
    acquisitionDate: new Date('2022-01-01'),
    sector: 'tech_software',
    stateCode: 'CA',
    filingStatus: 'single',
    ordinaryIncome: 200000,
    totalAssets: 1200000,
    volatility: 0.45,
    expectedPositionReturn: 0.1,
    expectedMarketReturn: 0.07,
    ...overrides,
  } as ConcentrationInputs;
}

describe('concentration hedging output', () => {
  it('defaults to a 1-year 30%-OTM put when no hedgeChoice is given', () => {
    const h = calculate(input()).hedging;
    expect(h.kind).toBe('put');
    expect(h.protectionLevel).toBeCloseTo(0.3, 6);
    expect(h.tenorYears).toBe(1);
    expect(h.strike).toBeCloseTo(400000 * 0.7, 6);
    expect(h.netPremium).toBe(h.putPrice);
    expect(h.callStrike).toBeUndefined();
  });

  it('threads a put hedgeChoice: floor and tenor override the defaults', () => {
    const h = calculate(input({ hedgeChoice: { kind: 'put', protectionLevel: 0.1, tenorYears: 2 } })).hedging;
    expect(h.kind).toBe('put');
    expect(h.protectionLevel).toBe(0.1);
    expect(h.tenorYears).toBe(2);
    expect(h.strike).toBeCloseTo(400000 * 0.9, 6); // 10% OTM, not 30%
    expect(h.callStrike).toBeUndefined();
    expect(h.netPremium).toBe(h.putPrice);
  });

  it('threads a collar hedgeChoice: prices a short call and nets the premium down', () => {
    const h = calculate(
      input({ hedgeChoice: { kind: 'collar', protectionLevel: 0.1, tenorYears: 0.5, upsideCapPct: 0.2 } }),
    ).hedging;
    expect(h.kind).toBe('collar');
    expect(h.callStrike).toBeCloseTo(400000 * 1.2, 6);
    expect(h.callPrice).toBeGreaterThan(0);
    // Selling the call finances most of the put, so net < gross put premium.
    expect(h.netPremium).toBeLessThan(h.putPrice);
    expect(h.netPremium).toBeCloseTo(Math.max(0, h.putPrice - (h.callPrice ?? 0)), 6);
  });
});
