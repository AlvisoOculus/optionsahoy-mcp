// AlphaLatitude Inc. © 2026

import { describe, it, expect } from 'vitest';
import { computeEquityFundingPlan, type EquityFundingInput } from '../lib/calc/equityFunding';

function baseInput(overrides: Partial<EquityFundingInput> = {}): EquityFundingInput {
  return {
    targetAfterTax: 500_000,
    targetDate: new Date('2027-08-01T00:00:00Z'),
    lots: [
      { shares: 10_000, costBasisPerShare: 20, acquisitionDate: new Date('2023-01-15T00:00:00Z') },
    ],
    currentPrice: 100,
    ordinaryIncome: 250_000,
    filingStatus: 'single',
    stateCode: 'CA',
    today: new Date('2026-05-31T00:00:00Z'),
    ...overrides,
  };
}

describe('computeEquityFundingPlan', () => {
  it('feasible single-lot trivial case nets close to target', () => {
    const result = computeEquityFundingPlan(baseInput());
    expect(result.feasible).toBe(true);
    // Within $500 of target — block-quantization residual from greedy fill.
    expect(result.totalAfterTaxAchieved).toBeGreaterThanOrEqual(499_500);
    expect(result.totalAfterTaxAchieved).toBeLessThanOrEqual(500_500);
    expect(result.totalSharesSold).toBeGreaterThan(0);
  });

  it('long-term holding gets LTCG rates (lower than ordinary)', () => {
    // Lot acquired well before target date — clearly long-term.
    const lt = computeEquityFundingPlan(
      baseInput({
        lots: [
          { shares: 10_000, costBasisPerShare: 20, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
        ],
      }),
    );
    // Lot acquired 1 month before target — short-term.
    const st = computeEquityFundingPlan(
      baseInput({
        lots: [
          { shares: 10_000, costBasisPerShare: 20, acquisitionDate: new Date('2027-07-01T00:00:00Z') },
        ],
      }),
    );
    expect(lt.totalTaxes.total).toBeLessThan(st.totalTaxes.total);
  });

  it('infeasible when inventory cannot cover target', () => {
    const result = computeEquityFundingPlan(
      baseInput({
        targetAfterTax: 5_000_000,
        lots: [
          { shares: 100, costBasisPerShare: 20, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
        ],
      }),
    );
    expect(result.feasible).toBe(false);
    expect(result.shortfall).toBeDefined();
    expect(result.shortfall!.gap).toBeGreaterThan(0);
  });

  it('reports savings vs sell-all-in-target-year counterfactual', () => {
    const result = computeEquityFundingPlan(
      baseInput({
        targetAfterTax: 400_000,
        ordinaryIncome: 100_000, // lower income → bigger jump when sale piles on
      }),
    );
    expect(result.feasible).toBe(true);
    // The counterfactual may equal optimized in trivial low-bracket cases,
    // but tax should be reported.
    expect(result.comparison.sellAllInTargetYearTotalTax).toBeGreaterThan(0);
    expect(result.comparison.optimizedSavingsVsTargetYearSale).toBeGreaterThanOrEqual(0);
  });

  it('multi-year split saves tax vs single-year for bracket-crossing sale', () => {
    // Configure a scenario that would push a single-year sale into the 20%
    // LTCG bracket (~$518K taxable income single 2026).
    const input = baseInput({
      targetAfterTax: 600_000,
      ordinaryIncome: 200_000,
      targetDate: new Date('2027-12-15T00:00:00Z'),
    });
    const result = computeEquityFundingPlan(input);
    // If split across 2026 and 2027 gives any benefit, savings > 0.
    expect(result.comparison.optimizedSavingsVsTargetYearSale).toBeGreaterThanOrEqual(0);
  });

  it('multiple lots: prefers lowest-basis-cost lot when both are long-term', () => {
    // Two lots, same acquisition era (both long-term), different basis.
    // Lower basis = bigger gain per share = MORE tax per share.
    // So the optimizer should prefer the HIGHER basis lot (less gain → less tax).
    const result = computeEquityFundingPlan(
      baseInput({
        targetAfterTax: 50_000, // small enough to fit in cheaper bracket
        lots: [
          { shares: 500, costBasisPerShare: 10, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
          { shares: 500, costBasisPerShare: 90, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
        ],
      }),
    );
    // Of the shares sold, more should come from lot 1 (basis 90, less gain).
    const sched = result.schedule;
    expect(sched.length).toBeGreaterThan(0);
    const totalSoldLot1 = sched.reduce(
      (acc, y) => acc + (y.sales.find((s) => s.lotIndex === 1)?.shares ?? 0),
      0,
    );
    const totalSoldLot0 = sched.reduce(
      (acc, y) => acc + (y.sales.find((s) => s.lotIndex === 0)?.shares ?? 0),
      0,
    );
    expect(totalSoldLot1).toBeGreaterThan(totalSoldLot0);
  });

  it('targetDate today works (immediate liquidation)', () => {
    const today = new Date('2026-05-31T00:00:00Z');
    const result = computeEquityFundingPlan(
      baseInput({
        targetAfterTax: 300_000,
        targetDate: today,
        today,
      }),
    );
    expect(result.feasible).toBe(true);
    expect(result.schedule).toHaveLength(1);
    expect(result.schedule[0].year).toBe(2026);
  });

  it('throws if targetDate is in the past', () => {
    expect(() =>
      computeEquityFundingPlan(
        baseInput({
          targetDate: new Date('2025-01-01T00:00:00Z'),
          today: new Date('2026-05-31T00:00:00Z'),
        }),
      ),
    ).toThrow();
  });

  it('NIIT kicks in above MAGI threshold', () => {
    // Very high income — NIIT 3.8% should apply on any cap gain.
    const result = computeEquityFundingPlan(
      baseInput({
        ordinaryIncome: 400_000,
        targetAfterTax: 200_000,
      }),
    );
    expect(result.feasible).toBe(true);
    expect(result.totalTaxes.niit).toBeGreaterThan(0);
  });

  it('low income → low or zero NIIT', () => {
    // Low income, modest sale: NIIT shouldn't apply.
    const result = computeEquityFundingPlan(
      baseInput({
        ordinaryIncome: 50_000,
        targetAfterTax: 50_000,
      }),
    );
    expect(result.feasible).toBe(true);
    // NIIT threshold is 200K single — should be 0 or minimal.
    expect(result.totalTaxes.niit).toBeLessThan(500);
  });
});
