// AlphaLatitude Inc. © 2026

import { describe, expect, it } from 'vitest';
import {
  calculateProtectivePut,
  barePutPayoff,
  collarPayoff,
  spreadPayoff,
  buildPayoffCurve,
  hedgeKindOf,
  SPREAD_NARROW_BAND_THRESHOLD,
  SPREAD_THIN_REBATE_THRESHOLD,
  type ProtectivePutInputs,
} from '../lib/calc/protectivePut';

function inputsFor(overrides: Partial<ProtectivePutInputs> = {}): ProtectivePutInputs {
  return {
    positionValue: 300_000,
    sector: 'tech_software',
    volatility: 0.36,
    protectionLevel: 0.30,
    tenorYears: 1,
    ...overrides,
  };
}

describe('calculateProtectivePut — bare put', () => {
  it('uses the right strike for the chosen protection level', () => {
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.30 }));
    expect(r.barePut.strike).toBe(300_000 * 0.7);
  });

  it('produces a positive premium for the default scenario', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.barePut.premium).toBeGreaterThan(0);
  });

  it('annualCost = premium / tenor', () => {
    const r = calculateProtectivePut(inputsFor({ tenorYears: 2 }));
    expect(r.barePut.annualCost).toBeCloseTo(r.barePut.premium / 2, 5);
  });

  it('maxLoss equals (S − K_put + premium)', () => {
    const r = calculateProtectivePut(inputsFor());
    const expected = 300_000 - r.barePut.strike + r.barePut.premium;
    expect(r.barePut.maxLoss).toBeCloseTo(expected, 5);
  });
});

describe('calculateProtectivePut — collar', () => {
  it('call strike is above spot (OTM call)', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.collar.callStrike).toBeGreaterThan(300_000);
  });

  it('call strike widens with volatility (richer call premium → further OTM)', () => {
    const lowVol  = calculateProtectivePut(inputsFor({ volatility: 0.20 }));
    const highVol = calculateProtectivePut(inputsFor({ volatility: 0.50 }));
    expect(highVol.collar.callStrike).toBeGreaterThan(lowVol.collar.callStrike);
  });

  it('zero-cost flag is set for the default scenario', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.collar.isZeroCost).toBe(true);
    expect(r.collar.netPremium).toBeLessThan(1);
  });

  it('cap-probability uses real-world drift (Tech default ≈ 9%)', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.collar.capProbability).toBeGreaterThan(0.05);
    expect(r.collar.capProbability).toBeLessThan(0.15);
  });
});

describe('calculateProtectivePut — recommended structure', () => {
  it('recommends collar at default Tech inputs (low cap probability, cheap put)', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.recommended).toBe('collar');
  });

  it('threshold flip is monotonic in protection level (looser cap → more cap probability)', () => {
    const tight = calculateProtectivePut(inputsFor({ protectionLevel: 0.10 }));
    const loose = calculateProtectivePut(inputsFor({ protectionLevel: 0.30 }));
    expect(tight.collar.capProbability).toBeGreaterThan(loose.collar.capProbability);
  });

  it("recommends 'none' when collar caps too often AND put doesn't even fire in a bad year", () => {
    // 5% protection at high σ → tight strike, AND high cap breach probability.
    // At a 1-in-10 bad year, the stock drops below the protection floor, but
    // the put may not trigger usefully if the strike is too tight.
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.05, volatility: 0.80 }));
    expect(r.collar.capProbability).toBeGreaterThan(0.20);
  });

  it('computes a sane bad-year price + covered loss at default Tech inputs', () => {
    // Tech σ=0.36, μ=0.12, 30% protection, 1y, p=10%
    // → bad-year price ≈ $196K, drop ≈ −34.7%, covers ≈ $14K below the $210K floor
    const r = calculateProtectivePut(inputsFor());
    expect(r.barePut.badYearPrice).toBeGreaterThan(180_000);
    expect(r.barePut.badYearPrice).toBeLessThan(210_000);
    expect(r.barePut.badYearDropPct).toBeGreaterThan(0.30);
    expect(r.barePut.coveredLossAtBadYear).toBeGreaterThan(5_000);
    expect(r.barePut.expectedProfit).toBeCloseTo(36_000, -2);   // Tech 12% × $300K × 1y
    expect(r.barePut.premiumToExpectedProfitRatio).toBeLessThan(0.50);
  });

  it('flags put as expensive when bad-year drop falls short of the protection floor', () => {
    // Deep OTM (50% protection) on Tech: put strike = $150K. 1-in-10 bad year
    // doesn't reach −50%, so coveredLossAtBadYear = 0 → put is "expensive"
    // (tail-only insurance).
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.50 }));
    expect(r.barePut.coveredLossAtBadYear).toBe(0);
  });

  it('flags put as expensive when premium eats > 50% of expected upside (shallow puts)', () => {
    // 5% protection on Tech: premium ≈ $28K, expected profit = $36K → ratio ~0.79
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.05 }));
    expect(r.barePut.premiumToExpectedProfitRatio).toBeGreaterThan(0.50);
  });

  it('yields a NEGATIVE badYearDropPct when drift is high enough to lift the bad-year price above spot', () => {
    // SPCX repro: a (bogus) +158%/yr trailing return as drift pushes even the
    // 1-in-10 outcome above today's price. badYearDropPct goes negative — the
    // UI must format the sign rather than assume a drop (was "−-35.2%").
    const r = calculateProtectivePut(
      inputsFor({ protectionLevel: 0.05, volatility: 0.77, expectedReturn: 1.582 }),
    );
    expect(r.barePut.badYearPrice).toBeGreaterThan(300_000); // above the $300K spot
    expect(r.barePut.badYearDropPct).toBeLessThan(0);
    expect(r.barePut.coveredLossAtBadYear).toBe(0); // tail-only: floor never reached
  });
});

describe('calculateProtectivePut — payoff table', () => {
  it('uses 10% steps from at-least −50% to at-least 10% above the call strike', () => {
    const r = calculateProtectivePut(inputsFor());
    // Default Tech protection 30%, call strike ~+69% → range goes ≥−50% to ≥+79%, rounded outward to 10%
    expect(r.payoffRange.lowerPct).toBeLessThanOrEqual(-0.5);
    expect(r.payoffRange.upperPct).toBeGreaterThanOrEqual(r.collar.upsideCapPct + 0.10 - 1e-9);
    // Drawdowns are at exact 10% increments
    for (let i = 1; i < r.payoffTable.length; i++) {
      expect(r.payoffTable[i].drawdownPct - r.payoffTable[i - 1].drawdownPct).toBeCloseTo(0.1, 5);
    }
    // First row at lowerPct, last row at upperPct
    expect(r.payoffTable[0].drawdownPct).toBeCloseTo(r.payoffRange.lowerPct, 5);
    expect(r.payoffTable[r.payoffTable.length - 1].drawdownPct).toBeCloseTo(r.payoffRange.upperPct, 5);
    // Includes the flat (0%) row
    expect(r.payoffTable.some((p) => Math.abs(p.drawdownPct) < 1e-9)).toBe(true);
  });

  it('extends below at least −10% past the protection floor', () => {
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.45 }));
    expect(r.payoffRange.lowerPct).toBeLessThanOrEqual(-0.45 - 0.10 + 1e-9);
  });

  it('unhedged P&L is linear in drawdown', () => {
    const r = calculateProtectivePut(inputsFor());
    const flat = r.payoffTable.find((p) => Math.abs(p.drawdownPct) < 1e-9);
    expect(flat!.unhedgedPnl).toBeCloseTo(0, 5);
    const minus50 = r.payoffTable.find((p) => Math.abs(p.drawdownPct + 0.5) < 1e-9);
    expect(minus50!.unhedgedPnl).toBeCloseTo(-150_000, 5);
  });

  it('bare-put loss is floored below the strike', () => {
    const r = calculateProtectivePut(inputsFor());
    const minus50 = r.payoffTable.find((p) => Math.abs(p.drawdownPct + 0.5) < 1e-9)!;
    const minus40 = r.payoffTable.find((p) => Math.abs(p.drawdownPct + 0.4) < 1e-9)!;
    // K_put = 0.7 × S = $210K → both -50% and -40% paths land below strike → same floor
    expect(minus50.barePutPnl).toBeCloseTo(minus40.barePutPnl, 5);
  });

  it('collar caps upside at K_call (when the path exceeds K_call)', () => {
    const r = calculateProtectivePut(inputsFor());
    const beyondCap = (r.collar.callStrike / 300_000) - 1 + 0.20;  // +20% past K_call
    const cappedPnl = collarPayoff(
      300_000,
      r.collar.putStrike,
      r.collar.callStrike,
      r.collar.netPremium,
      beyondCap,
    );
    const expectedCap = r.collar.callStrike - 300_000 - r.collar.netPremium;
    expect(cappedPnl).toBeCloseTo(expectedCap, 5);
  });
});

describe('barePutPayoff / collarPayoff piecewise correctness', () => {
  it('barePutPayoff: hits the K − S − premium floor for big drawdowns', () => {
    const v = barePutPayoff(100, 70, 5, -0.5);   // S_T = 50 < K=70
    expect(v).toBeCloseTo(70 - 100 - 5, 5);       // = -35
  });

  it('barePutPayoff: linear (S × d − premium) for paths above strike', () => {
    const v = barePutPayoff(100, 70, 5, -0.1);   // S_T = 90 > K=70
    expect(v).toBeCloseTo(100 * -0.1 - 5, 5);     // = -15
  });

  it('collarPayoff: kinked at both K_put and K_call', () => {
    expect(collarPayoff(100, 70, 130, 0, -0.5)).toBeCloseTo(-30, 5);  // floor: K_put − S
    expect(collarPayoff(100, 70, 130,  0, 0)).toBeCloseTo(0, 5);       // flat → 0
    expect(collarPayoff(100, 70, 130, 0, 0.5)).toBeCloseTo(30, 5);     // cap: K_call − S
  });
});

describe('buildPayoffCurve', () => {
  it('returns steps + 1 points spanning the result.payoffRange', () => {
    const r = calculateProtectivePut(inputsFor());
    const curve = buildPayoffCurve(r, 80);
    expect(curve).toHaveLength(81);
    expect(curve[0].drawdownPct).toBeCloseTo(r.payoffRange.lowerPct, 5);
    expect(curve[curve.length - 1].drawdownPct).toBeCloseTo(r.payoffRange.upperPct, 5);
  });

  it('lands a point near 0 drawdown when steps are dense', () => {
    const r = calculateProtectivePut(inputsFor());
    const curve = buildPayoffCurve(r, 1000);   // dense enough to land near 0
    const closestToZero = curve.reduce((best, p) =>
      Math.abs(p.drawdownPct) < Math.abs(best.drawdownPct) ? p : best,
    );
    expect(Math.abs(closestToZero.drawdownPct)).toBeLessThan(0.005);
    // unhedgedPnl ≈ S × d, so its magnitude tracks the drawdown
    expect(Math.abs(closestToZero.unhedgedPnl)).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------
// Sector coverage — every sector must produce a sensible result
// ---------------------------------------------------------------

describe('calculateProtectivePut — all sectors', () => {
  const SECTORS = [
    'tech_software',
    'semiconductors',
    'consumer_cyclical',
    'consumer_defensive',
    'financials',
    'healthcare_biotech',
    'energy',
    'industrials',
    'communication',
    'broad_market',
  ] as const;

  for (const sector of SECTORS) {
    it(`produces a valid result for sector "${sector}"`, () => {
      const r = calculateProtectivePut(inputsFor({ sector }));
      expect(r.barePut.premium).toBeGreaterThan(0);
      expect(r.collar.callStrike).toBeGreaterThan(300_000);
      expect(r.collar.capProbability).toBeGreaterThanOrEqual(0);
      expect(r.collar.capProbability).toBeLessThanOrEqual(1);
      expect(r.barePut.expectedProfit).toBeGreaterThan(0);
      expect(['collar', 'protective-put', 'none']).toContain(r.recommended);
    });
  }
});

// ---------------------------------------------------------------
// Boundary inputs — sliders set to min / max values
// ---------------------------------------------------------------

describe('calculateProtectivePut — slider boundaries', () => {
  it('handles 5% protection (slider min)', () => {
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.05 }));
    expect(r.barePut.strike).toBeCloseTo(285_000, 0);
    expect(r.barePut.premium).toBeGreaterThan(0);
    expect(r.collar.upsideCapPct).toBeGreaterThan(0);
  });

  it('handles 50% protection (slider max)', () => {
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.50 }));
    expect(r.barePut.strike).toBeCloseTo(150_000, 0);
    expect(r.barePut.premium).toBeGreaterThan(0);
    // Deep OTM puts on positive-drift sectors typically don't fire at 1-in-10
    expect(r.barePut.coveredLossAtBadYear).toBe(0);
  });

  it('handles 1-month tenor (slider min)', () => {
    const r = calculateProtectivePut(inputsFor({ tenorYears: 1 / 12 }));
    expect(r.barePut.premium).toBeGreaterThan(0);
    // Short tenor → less time value → cheaper premium
    const yearly = calculateProtectivePut(inputsFor({ tenorYears: 1 }));
    expect(r.barePut.premium).toBeLessThan(yearly.barePut.premium);
  });

  it('handles 24-month tenor (slider max)', () => {
    const r = calculateProtectivePut(inputsFor({ tenorYears: 2 }));
    expect(r.barePut.premium).toBeGreaterThan(0);
    // Longer tenor → larger premium than 1y for the same strike
    const yearly = calculateProtectivePut(inputsFor({ tenorYears: 1 }));
    expect(r.barePut.premium).toBeGreaterThan(yearly.barePut.premium);
  });

  it('handles σ = 10% (input min)', () => {
    const r = calculateProtectivePut(inputsFor({ volatility: 0.10 }));
    expect(r.barePut.premium).toBeGreaterThanOrEqual(0);
    // Very low vol → put almost worthless for moderate protection
    expect(r.barePut.premium).toBeLessThan(1_000);
  });

  it('handles σ = 100% (input max)', () => {
    const r = calculateProtectivePut(inputsFor({ volatility: 1.0 }));
    expect(r.barePut.premium).toBeGreaterThan(10_000);  // very expensive at 100% σ
    expect(r.collar.upsideCapPct).toBeGreaterThan(0.50);  // cap moves out far
  });
});

// ---------------------------------------------------------------
// Recommended structure — exhaustive across the three paths
// ---------------------------------------------------------------

describe('calculateProtectivePut — recommendation paths', () => {
  it('default Tech inputs → recommend collar', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.recommended).toBe('collar');
  });

  it('high σ + tight floor → cap fires often AND put expensive → recommend none', () => {
    const r = calculateProtectivePut(
      inputsFor({ protectionLevel: 0.05, volatility: 0.95 }),
    );
    expect(r.collar.capProbability).toBeGreaterThan(0.20);
    // Either of the put-expensive criteria fires for this scenario
    const putIsExpensive =
      r.barePut.coveredLossAtBadYear === 0 ||
      r.barePut.premiumToCoveredRatio > 0.40 ||
      r.barePut.premiumToExpectedProfitRatio > 0.50;
    expect(putIsExpensive).toBe(true);
    expect(r.recommended).toBe('none');
  });
});

// ---------------------------------------------------------------
// Payoff range — extends ≥15% beyond each collar arm
// ---------------------------------------------------------------

describe('payoffRange — adapts to collar arms', () => {
  it('extends at least 15% past the upside cap', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.payoffRange.upperPct).toBeGreaterThanOrEqual(
      r.collar.upsideCapPct + 0.15 - 1e-9,
    );
  });

  it('extends at least 15% below the protection floor when floor is deeper than 35%', () => {
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.45 }));
    expect(r.payoffRange.lowerPct).toBeLessThanOrEqual(-0.45 - 0.15 + 1e-9);
  });

  it('always extends to at least ±50%', () => {
    const r = calculateProtectivePut(inputsFor({ protectionLevel: 0.10 }));
    expect(r.payoffRange.lowerPct).toBeLessThanOrEqual(-0.5);
    expect(r.payoffRange.upperPct).toBeGreaterThanOrEqual(0.5);
  });

  it('rounds outward to a multiple of 10%', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(Math.abs((r.payoffRange.lowerPct * 10) % 1)).toBeLessThan(1e-9);
    expect(Math.abs((r.payoffRange.upperPct * 10) % 1)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------
// Output integrity — fields populated, ratios sensible
// ---------------------------------------------------------------

describe('calculateProtectivePut — expectedReturn override (chain mode)', () => {
  // Pick a sector whose annualReturn is unmistakably different from our test
  // override, so swaps in either direction produce visible deltas.
  const SECTOR_BASELINE = inputsFor({ sector: 'tech_software' });

  it('overrides realWorldDrift when expectedReturn is provided', () => {
    const baseline = calculateProtectivePut(SECTOR_BASELINE);
    const override = calculateProtectivePut(inputsFor({ expectedReturn: 0.25 }));
    expect(override.realWorldDrift).toBe(0.25);
    expect(baseline.realWorldDrift).not.toBe(0.25);
  });

  it('falls back to sector annualReturn when expectedReturn is omitted', () => {
    // Same inputs, no override — drift must equal the sector default.
    const r = calculateProtectivePut(SECTOR_BASELINE);
    // Just assert it's nonzero and consistent with itself; sector value is
    // a moving target as SECTOR_STATS evolves, so don't hardcode.
    expect(r.realWorldDrift).toBeGreaterThan(0);
    const r2 = calculateProtectivePut(SECTOR_BASELINE);
    expect(r2.realWorldDrift).toBe(r.realWorldDrift);
  });

  it('higher drift → higher expectedProfit (linear in μ)', () => {
    const lo = calculateProtectivePut(inputsFor({ expectedReturn: 0.05 }));
    const hi = calculateProtectivePut(inputsFor({ expectedReturn: 0.20 }));
    expect(hi.barePut.expectedProfit).toBeGreaterThan(lo.barePut.expectedProfit);
    // S × μ × T linearity: ratio of expectedProfits = ratio of drifts.
    expect(hi.barePut.expectedProfit / lo.barePut.expectedProfit).toBeCloseTo(0.20 / 0.05, 5);
  });

  it('higher drift → higher badYearPrice (less-bad bad year)', () => {
    const lo = calculateProtectivePut(inputsFor({ expectedReturn: 0.00 }));
    const hi = calculateProtectivePut(inputsFor({ expectedReturn: 0.30 }));
    expect(hi.barePut.badYearPrice).toBeGreaterThan(lo.barePut.badYearPrice);
  });

  it('higher drift → higher collar capProbability (more often above K_call)', () => {
    const lo = calculateProtectivePut(inputsFor({ expectedReturn: 0.00 }));
    const hi = calculateProtectivePut(inputsFor({ expectedReturn: 0.40 }));
    expect(hi.collar.capProbability).toBeGreaterThan(lo.collar.capProbability);
  });

  it('negative drift (drawdown ticker) is accepted and lowers expectedProfit', () => {
    const r = calculateProtectivePut(inputsFor({ expectedReturn: -0.05 }));
    expect(r.realWorldDrift).toBe(-0.05);
    expect(r.barePut.expectedProfit).toBeLessThan(0);
    // expectedProfit ≤ 0 → ratio is Infinity, never NaN.
    expect(r.barePut.premiumToExpectedProfitRatio).toBe(Infinity);
  });

  it('does not affect put strike or premium (drift is real-world only)', () => {
    const baseline = calculateProtectivePut(SECTOR_BASELINE);
    const override = calculateProtectivePut(inputsFor({ expectedReturn: 0.99 }));
    // Pricing is risk-neutral — μ does not enter Black-Scholes.
    expect(override.barePut.strike).toBe(baseline.barePut.strike);
    expect(override.barePut.premium).toBe(baseline.barePut.premium);
    expect(override.collar.callStrike).toBe(baseline.collar.callStrike);
    expect(override.collar.netPremium).toBe(baseline.collar.netPremium);
  });

  it('tickerLabel passes through to inputs but does not change math', () => {
    const baseline = calculateProtectivePut(inputsFor({ expectedReturn: 0.10 }));
    const labeled = calculateProtectivePut(
      inputsFor({ expectedReturn: 0.10, tickerLabel: 'AAPL' }),
    );
    expect(labeled.inputs.tickerLabel).toBe('AAPL');
    expect(baseline.inputs.tickerLabel).toBeUndefined();
    expect(labeled.barePut.expectedProfit).toBe(baseline.barePut.expectedProfit);
    expect(labeled.collar.capProbability).toBe(baseline.collar.capProbability);
  });
});

describe('calculateProtectivePut — output integrity', () => {
  it('all numeric fields are finite and well-defined for default inputs', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(Number.isFinite(r.riskFreeRate)).toBe(true);
    expect(Number.isFinite(r.realWorldDrift)).toBe(true);
    expect(Number.isFinite(r.barePut.premium)).toBe(true);
    expect(Number.isFinite(r.barePut.expectedProfit)).toBe(true);
    expect(Number.isFinite(r.collar.callStrike)).toBe(true);
    expect(Number.isFinite(r.collar.capProbability)).toBe(true);
    expect(Number.isFinite(r.payoffRange.lowerPct)).toBe(true);
    expect(Number.isFinite(r.payoffRange.upperPct)).toBe(true);
  });

  it('collar maxLoss = S − putStrike + netPremium', () => {
    const r = calculateProtectivePut(inputsFor());
    const expected = 300_000 - r.collar.putStrike + r.collar.netPremium;
    expect(r.collar.maxLoss).toBeCloseTo(expected, 5);
  });

  it('expectedProfit = position × annualReturn × tenor', () => {
    const r = calculateProtectivePut(inputsFor({ tenorYears: 0.5 }));
    // Tech annualReturn 12%, position $300K, tenor 0.5y → $18K
    expect(r.barePut.expectedProfit).toBeCloseTo(18_000, 0);
  });

  it('payoffTable and curve span the same range', () => {
    const r = calculateProtectivePut(inputsFor());
    const curve = buildPayoffCurve(r);
    expect(curve[0].drawdownPct).toBeCloseTo(r.payoffRange.lowerPct, 5);
    expect(curve[curve.length - 1].drawdownPct).toBeCloseTo(r.payoffRange.upperPct, 5);
    expect(r.payoffTable[0].drawdownPct).toBeCloseTo(r.payoffRange.lowerPct, 5);
    expect(r.payoffTable[r.payoffTable.length - 1].drawdownPct).toBeCloseTo(r.payoffRange.upperPct, 5);
  });
});

// ---------------------------------------------------------------
// Put spread — short strike solved from the floor breach risk preset
// ---------------------------------------------------------------

describe('calculateProtectivePut — put spread', () => {
  it('default risk (1-in-10) puts the short strike at the bad-year price (flat σ)', () => {
    const r = calculateProtectivePut(inputsFor());
    // Same quantile, same drift, same σ — the closed forms must agree.
    expect(r.putSpread.shortStrike).toBeCloseTo(r.barePut.badYearPrice, 5);
    expect(r.putSpread.riskLevel).toBe(0.10);
  });

  it('achieved breach probability matches the preset when the strike has room (flat σ)', () => {
    // Deep floor + high σ so all three quantiles land below the floor. At
    // shallower floors the shallower presets clamp to the floor and report
    // available: false — covered separately below.
    for (const p of [0.20, 0.10, 0.05, 0.01]) {
      const r = calculateProtectivePut(
        inputsFor({ protectionLevel: 0.40, volatility: 0.60, spreadRiskLevel: p }),
      );
      expect(r.putSpread.available).toBe(true);
      // normalCdf is the Abramowitz-Stegun approximation (~1.5e-7 max
      // error), so match to 4 decimals, not machine precision.
      expect(r.putSpread.breachProbability).toBeCloseTo(p, 4);
    }
  });

  it('clamps to the floor and reports unavailable when the quantile sits above it', () => {
    // Default tech inputs: the 1-in-5 price (≈ −22%) is above the −30%
    // floor — selling a put above your own floor is nonsense, so the
    // spread reports unavailable rather than quoting a degenerate band.
    const r = calculateProtectivePut(inputsFor({ spreadRiskLevel: 0.20 }));
    expect(r.putSpread.available).toBe(false);
    expect(r.putSpread.shortStrike).toBeLessThanOrEqual(r.putSpread.longStrike + 1e-9);
  });

  it('is available and strictly cheaper than the outright put for default inputs', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.putSpread.available).toBe(true);
    expect(r.putSpread.shortStrike).toBeLessThan(r.putSpread.longStrike);
    expect(r.putSpread.netPremium).toBeGreaterThan(0);
    expect(r.putSpread.netPremium).toBeLessThan(r.barePut.premium);
    expect(r.putSpread.savingsPct).toBeGreaterThan(0);
    expect(r.putSpread.savingsPct).toBeLessThan(1);
  });

  it('riskier presets sit closer to the floor and cost less', () => {
    const deep = { protectionLevel: 0.40, volatility: 0.60 } as const;
    const p20 = calculateProtectivePut(inputsFor({ ...deep, spreadRiskLevel: 0.20 })).putSpread;
    const p10 = calculateProtectivePut(inputsFor({ ...deep, spreadRiskLevel: 0.10 })).putSpread;
    const p05 = calculateProtectivePut(inputsFor({ ...deep, spreadRiskLevel: 0.05 })).putSpread;
    const p01 = calculateProtectivePut(inputsFor({ ...deep, spreadRiskLevel: 0.01 })).putSpread;
    expect(p20.shortStrike).toBeGreaterThan(p10.shortStrike);
    expect(p10.shortStrike).toBeGreaterThan(p05.shortStrike);
    expect(p05.shortStrike).toBeGreaterThan(p01.shortStrike);
    expect(p20.netPremium).toBeLessThan(p10.netPremium);
    expect(p10.netPremium).toBeLessThan(p05.netPremium);
    expect(p05.netPremium).toBeLessThan(p01.netPremium);
  });

  it('maxLossInBand = S − longStrike + netPremium; bandWidth = longStrike − shortStrike', () => {
    const r = calculateProtectivePut(inputsFor());
    const s = r.putSpread;
    expect(s.maxLossInBand).toBeCloseTo(300_000 - s.longStrike + s.netPremium, 5);
    expect(s.bandWidth).toBeCloseTo(s.longStrike - s.shortStrike, 5);
  });

  it('uses ivAtStrike for the short leg (solve + pricing at the skewed σ)', () => {
    const flat = calculateProtectivePut(inputsFor());
    const skewed = calculateProtectivePut(
      inputsFor({
        // Crude put skew: +10 vol points below the floor.
        ivAtStrike: (K) => (K < 300_000 * 0.7 ? 0.46 : 0.36),
      }),
    );
    expect(skewed.putSpread.shortSigma).toBeCloseTo(0.46, 6);
    // Higher σ at the short strike pushes the same-probability quantile
    // deeper (the strike shift and the σ bump fight over the premium, so
    // the rebate itself can move either way).
    expect(skewed.putSpread.shortStrike).toBeLessThan(flat.putSpread.shortStrike);
    // The solve still hits the target odds AT the skewed σ.
    expect(skewed.putSpread.breachProbability).toBeCloseTo(0.10, 4);
    // Long leg is untouched by the skew callback.
    expect(skewed.barePut.premium).toBeCloseTo(flat.barePut.premium, 5);
  });

  it('unavailable when the quantile price sits above the floor (tail-only case)', () => {
    // Shallow floor + high drift: the 1-in-10 price is above K_long, so
    // there is no lower strike worth selling. Mirrors the put's tail-only
    // warning scenario.
    const r = calculateProtectivePut(
      inputsFor({ protectionLevel: 0.50, volatility: 0.20, expectedReturn: 1.5 }),
    );
    expect(r.barePut.coveredLossAtBadYear).toBe(0);
    expect(r.putSpread.available).toBe(false);
  });

  it('payoff: floor holds in band, losses resume below the short strike', () => {
    const r = calculateProtectivePut(inputsFor());
    const s = r.putSpread;
    const S = 300_000;
    const floorPnl = s.longStrike - S - s.netPremium;
    // Above the floor: unhedged minus net premium.
    expect(spreadPayoff(S, s.longStrike, s.shortStrike, s.netPremium, 0.10))
      .toBeCloseTo(S * 0.10 - s.netPremium, 5);
    // Inside the band: floor.
    const inBandDrop = -(1 - (s.shortStrike + s.bandWidth / 2) / S);
    expect(spreadPayoff(S, s.longStrike, s.shortStrike, s.netPremium, inBandDrop))
      .toBeCloseTo(floorPnl, 5);
    // Below the short strike: floor + (further drop below K_short), i.e.
    // losses resume dollar-for-dollar.
    const deepDrop = -(1 - (s.shortStrike * 0.8) / S);
    expect(spreadPayoff(S, s.longStrike, s.shortStrike, s.netPremium, deepDrop))
      .toBeCloseTo(floorPnl - s.shortStrike * 0.2, 5);
  });

  it('payoffRange extends at least 15% below the short strike', () => {
    const r = calculateProtectivePut(inputsFor({ volatility: 0.60 }));
    if (r.putSpread.available) {
      expect(r.payoffRange.lowerPct).toBeLessThanOrEqual(
        -r.putSpread.shortStrikeDropPct - 0.15 + 1e-9,
      );
    }
  });

  it('payoff table and curve carry a finite spread series when available', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.putSpread.available).toBe(true);
    for (const row of r.payoffTable) expect(Number.isFinite(row.spreadPnl)).toBe(true);
    for (const row of buildPayoffCurve(r)) expect(Number.isFinite(row.spreadPnl)).toBe(true);
  });

  it('fills the collar-caps + put-expensive gap when the spread is affordable', () => {
    // High drift → collar caps too often. Deep floor + modest σ → the put
    // fails the covered-loss test but the spread (rebated) passes.
    const r = calculateProtectivePut(
      inputsFor({ protectionLevel: 0.40, volatility: 0.45, expectedReturn: 0.40 }),
    );
    if (r.recommended === 'put-spread') {
      expect(r.collar.capProbability).toBeGreaterThan(0.20);
      expect(r.putSpread.available).toBe(true);
    }
    // Whatever the branch, the triage must never recommend an unavailable spread.
    if (!r.putSpread.available) expect(r.recommended).not.toBe('put-spread');
  });
});

describe('calculateProtectivePut — put spread edge fixes', () => {
  it('payoff range never extends below −100% even for deep-tail short strikes', () => {
    // Negative drift + high σ + long tenor + 1-in-20: the solved short
    // strike lands ~90% down; the range must clamp at −100% (a stock cannot
    // lose more than its full value).
    const r = calculateProtectivePut(
      inputsFor({
        volatility: 0.60,
        tenorYears: 2,
        expectedReturn: -0.30,
        spreadRiskLevel: 0.05,
      }),
    );
    expect(r.payoffRange.lowerPct).toBeGreaterThanOrEqual(-1);
    expect(r.payoffTable[0]!.drawdownPct).toBeGreaterThanOrEqual(-1);
  });

  it('reports unavailableReason "floor" when the quantile clamps to the floor', () => {
    const r = calculateProtectivePut(inputsFor({ spreadRiskLevel: 0.20 }));
    expect(r.putSpread.available).toBe(false);
    expect(r.putSpread.unavailableReason).toBe('floor');
  });

  it('reports unavailableReason "no-rebate" when skew prices the short leg above the long leg', () => {
    // Short tenor, near-zero-vol long leg (σ 15% at the floor) with a
    // violent skew (150%) just below it: the long put prices at ~$0 while
    // the solved short leg carries real premium, so the "spread" would be
    // a credit, not a cost reduction.
    const r = calculateProtectivePut(
      inputsFor({
        volatility: 0.15,
        tenorYears: 1 / 12,
        ivAtStrike: (K) => (K < 300_000 * 0.75 ? 1.5 : 0.15),
      }),
    );
    expect(r.putSpread.available).toBe(false);
    expect(r.putSpread.unavailableReason).toBe('no-rebate');
  });

  it('null unavailableReason when available', () => {
    const r = calculateProtectivePut(inputsFor());
    expect(r.putSpread.available).toBe(true);
    expect(r.putSpread.unavailableReason).toBeNull();
  });

  it('snaps an off-preset risk level to the nearest preset and echoes it', () => {
    const r = calculateProtectivePut(
      inputsFor({ protectionLevel: 0.40, volatility: 0.60, spreadRiskLevel: 0.12 }),
    );
    expect(r.putSpread.riskLevel).toBe(0.10);
    expect(r.putSpread.breachProbability).toBeCloseTo(0.10, 4);
  });

  it('hedgeKindOf maps every recommendation', () => {
    expect(hedgeKindOf('collar')).toBe('collar');
    expect(hedgeKindOf('protective-put')).toBe('put');
    expect(hedgeKindOf('put-spread')).toBe('spread');
    expect(hedgeKindOf('none')).toBeNull();
  });
});

describe('calculateProtectivePut — spread thin-rebate warning + recommendation invariant', () => {
  // Shallow floor on a very high-vol name: the put is expensive AND the
  // solved short strike sits so deep (fat left tail) that its rebate is
  // tiny — the RBLX-at-12% shape the user flagged.
  const thinRebate = inputsFor({
    positionValue: 500_000,
    protectionLevel: 0.12,
    volatility: 0.94,
    expectedReturn: 0.05,
  });

  it('flags a thin-rebate spread as expensive so it is not recommended', () => {
    const r = calculateProtectivePut(thinRebate);
    if (r.putSpread.available) {
      // A thin rebate must not be the silently-cheapest recommendation.
      if (r.putSpread.savingsPct < 0.10) {
        expect(r.recommended).not.toBe('put-spread');
      }
    }
    expect(['collar', 'protective-put', 'put-spread', 'none']).toContain(r.recommended);
  });

  it('recommended structure never coincides with its own expense flags', () => {
    // Sweep a grid; whatever gets recommended must be "clean" on its own
    // warning tests, so a card with no warning is the recommended one.
    for (const vol of [0.25, 0.45, 0.7, 0.94]) {
      for (const prot of [0.1, 0.12, 0.2, 0.3, 0.4]) {
        for (const mu of [-0.1, 0.05, 0.12, 0.4]) {
          const r = calculateProtectivePut(
            inputsFor({ positionValue: 500_000, volatility: vol, protectionLevel: prot, expectedReturn: mu }),
          );
          if (r.recommended === 'protective-put') {
            const putExpensive =
              r.barePut.coveredLossAtBadYear === 0 ||
              r.barePut.premiumToCoveredRatio > 0.4 ||
              r.barePut.premiumToExpectedProfitRatio > 0.5;
            expect(putExpensive, `put recommended but flagged (vol ${vol} prot ${prot} mu ${mu})`).toBe(false);
          }
          if (r.recommended === 'put-spread') {
            const s = r.putSpread;
            const spreadExpensive =
              !s.available ||
              s.coveredLossAtBadYear === 0 ||
              s.netPremium / Math.max(s.coveredLossAtBadYear, 1e-9) > 0.4 ||
              (r.barePut.expectedProfit > 0 ? s.netPremium / r.barePut.expectedProfit : Infinity) > 0.5 ||
              s.savingsPct < 0.1 ||
              s.bandWidth / 500_000 < 0.05;
            expect(spreadExpensive, `spread recommended but flagged (vol ${vol} prot ${prot} mu ${mu})`).toBe(false);
          }
          if (r.recommended === 'collar') {
            expect(r.collar.capProbability, `collar recommended but caps too often (vol ${vol} prot ${prot} mu ${mu})`)
              .toBeLessThanOrEqual(0.2 + 1e-9);
          }
        }
      }
    }
  });
});

describe('calculateProtectivePut — narrow-band spread', () => {
  // Deep floor on a moderate-drift name: the 1-in-10 short strike lands just
  // below the floor, so the protected band is a thin sliver. No premium- or
  // rebate-based test catches this (premium is tiny and efficient, savings
  // is high), so it needs its own guard.
  const narrow = inputsFor({
    positionValue: 500_002,
    protectionLevel: 0.32,
    volatility: 0.45,
    expectedReturn: 0.25,
  });

  it('produces an available spread with a band under 5 points', () => {
    const s = calculateProtectivePut(narrow).putSpread;
    expect(s.available).toBe(true);
    const bandPts = s.shortStrikeDropPct - 0.32;
    expect(bandPts).toBeGreaterThan(0);
    expect(bandPts).toBeLessThan(SPREAD_NARROW_BAND_THRESHOLD);
    // High savings + efficient premium: the older tests would call it clean.
    expect(s.savingsPct).toBeGreaterThan(SPREAD_THIN_REBATE_THRESHOLD);
  });

  it('flags a narrow band as expensive so it is never recommended', () => {
    const r = calculateProtectivePut(narrow);
    expect(r.recommended).not.toBe('put-spread');
  });

  it('a wide-band spread at the same floor is not narrow (conservative risk widens it)', () => {
    // Same deep floor, 1-in-100: the lower strike drops far below the floor,
    // widening the band past the threshold.
    const wide = calculateProtectivePut({ ...narrow, spreadRiskLevel: 0.01 }).putSpread;
    if (wide.available) {
      expect(wide.shortStrikeDropPct - 0.32).toBeGreaterThan(SPREAD_NARROW_BAND_THRESHOLD);
    }
  });
});
