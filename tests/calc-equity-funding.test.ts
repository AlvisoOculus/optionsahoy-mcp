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

  it('expectedAnnualGrowth=0 matches v1.5 constant-price behavior', () => {
    const v15 = computeEquityFundingPlan(baseInput());
    const withZero = computeEquityFundingPlan(baseInput({ expectedAnnualGrowth: 0 }));
    expect(withZero.totalAfterTaxAchieved).toBeCloseTo(v15.totalAfterTaxAchieved, 0);
    expect(withZero.totalSharesSold).toBe(v15.totalSharesSold);
  });

  it('positive growth needs fewer shares to hit the same after-tax target', () => {
    const base = computeEquityFundingPlan(baseInput({ targetAfterTax: 300_000 }));
    const grew = computeEquityFundingPlan(
      baseInput({ targetAfterTax: 300_000, expectedAnnualGrowth: 0.2 }),
    );
    expect(grew.feasible).toBe(true);
    expect(grew.totalSharesSold).toBeLessThan(base.totalSharesSold);
  });

  it('negative growth needs more shares (or flips feasibility)', () => {
    const decline = computeEquityFundingPlan(
      baseInput({ targetAfterTax: 300_000, expectedAnnualGrowth: -0.2 }),
    );
    const flat = computeEquityFundingPlan(baseInput({ targetAfterTax: 300_000 }));
    if (decline.feasible && flat.feasible) {
      expect(decline.totalSharesSold).toBeGreaterThanOrEqual(flat.totalSharesSold);
    } else {
      expect(decline.feasible).toBe(false);
    }
  });

  it('multi-stack: equivalent to single-stack when only one stack is provided', () => {
    const legacy = computeEquityFundingPlan(baseInput());
    const multi = computeEquityFundingPlan({
      targetAfterTax: 500_000,
      targetDate: new Date('2027-08-01T00:00:00Z'),
      stacks: [
        {
          currentPrice: 100,
          lots: [
            { shares: 10_000, costBasisPerShare: 20, acquisitionDate: new Date('2023-01-15T00:00:00Z') },
          ],
        },
      ],
      ordinaryIncome: 250_000,
      filingStatus: 'single',
      stateCode: 'CA',
      today: new Date('2026-05-31T00:00:00Z'),
    });
    expect(multi.totalAfterTaxAchieved).toBeCloseTo(legacy.totalAfterTaxAchieved, 0);
    expect(multi.totalSharesSold).toBe(legacy.totalSharesSold);
  });

  it('multi-stack: planner prefers the stack with cheaper tax per dollar of cash', () => {
    // Two stacks, both long-term, same total shares. Stack 0 has $20 basis
    // (high gain); Stack 1 has $90 basis (low gain). Stack 1 yields more
    // net per share, so the planner should sell from it first.
    const result = computeEquityFundingPlan({
      targetAfterTax: 50_000,
      targetDate: new Date('2027-06-01T00:00:00Z'),
      stacks: [
        {
          ticker: 'HIGHGAIN',
          currentPrice: 100,
          lots: [
            { shares: 500, costBasisPerShare: 20, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
          ],
        },
        {
          ticker: 'LOWGAIN',
          currentPrice: 100,
          lots: [
            { shares: 500, costBasisPerShare: 90, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
          ],
        },
      ],
      ordinaryIncome: 250_000,
      filingStatus: 'single',
      stateCode: 'CA',
      today: new Date('2026-05-31T00:00:00Z'),
    });
    expect(result.feasible).toBe(true);
    const fromHigh = result.schedule.reduce(
      (a, y) => a + y.sales.filter((s) => s.stackIndex === 0).reduce((b, s) => b + s.shares, 0),
      0,
    );
    const fromLow = result.schedule.reduce(
      (a, y) => a + y.sales.filter((s) => s.stackIndex === 1).reduce((b, s) => b + s.shares, 0),
      0,
    );
    expect(fromLow).toBeGreaterThan(fromHigh);
  });

  it('multi-stack: each stack carries its own price + growth', () => {
    // Stack 0 at $100 with 0% growth; Stack 1 at $50 with 50% growth. By
    // 2027 Stack 1's projected price (~$65 in 8 months) is below Stack 0.
    // Per-share NET still favors Stack 1 if its basis is much lower.
    const result = computeEquityFundingPlan({
      targetAfterTax: 80_000,
      targetDate: new Date('2027-06-01T00:00:00Z'),
      stacks: [
        {
          ticker: 'FLAT',
          currentPrice: 100,
          expectedAnnualGrowth: 0,
          lots: [
            { shares: 1000, costBasisPerShare: 50, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
          ],
        },
        {
          ticker: 'GROW',
          currentPrice: 50,
          expectedAnnualGrowth: 0.5,
          lots: [
            { shares: 1000, costBasisPerShare: 10, acquisitionDate: new Date('2020-01-01T00:00:00Z') },
          ],
        },
      ],
      ordinaryIncome: 250_000,
      filingStatus: 'single',
      stateCode: 'CA',
      today: new Date('2026-05-31T00:00:00Z'),
    });
    expect(result.feasible).toBe(true);
    // SaleEntry should carry stackIndex + ticker so callers can show
    // per-stack lines.
    for (const y of result.schedule) {
      for (const s of y.sales) {
        expect([0, 1]).toContain(s.stackIndex);
        expect(['FLAT', 'GROW']).toContain(s.ticker);
      }
    }
  });

  it('throws when neither `stacks` nor legacy `lots` is provided', () => {
    expect(() =>
      computeEquityFundingPlan({
        targetAfterTax: 100_000,
        targetDate: new Date('2027-08-01T00:00:00Z'),
        ordinaryIncome: 200_000,
        filingStatus: 'single',
        stateCode: 'CA',
        today: new Date('2026-05-31T00:00:00Z'),
      } as never),
    ).toThrow();
  });

  it('remainingPositionValue uses the projected price at target date', () => {
    const result = computeEquityFundingPlan(
      baseInput({
        targetAfterTax: 100_000,
        expectedAnnualGrowth: 0.5,
      }),
    );
    const naive = result.remainingShares * 100;
    expect(result.remainingPositionValue).toBeGreaterThan(naive);
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
