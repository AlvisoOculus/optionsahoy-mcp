// AlphaLatitude Inc. © 2026
//
// Correctness tests for the RSU Lot Order engine (lotDivest.ts).

import { describe, it, expect } from 'vitest';
import { computeLotDivestPlan, type LotDivestInput } from '../lib/calc/lotDivest';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const TODAY = d('2026-07-23');

function base(over: Partial<LotDivestInput> = {}): LotDivestInput {
  return {
    lots: [
      { vestDate: d('2022-08-15'), shares: 120, costBasisPerShare: 95 },
      { vestDate: d('2024-02-15'), shares: 100, costBasisPerShare: 130 },
      { vestDate: d('2025-11-15'), shares: 90, costBasisPerShare: 165 },
      { vestDate: d('2026-05-15'), shares: 80, costBasisPerShare: 210 },
    ],
    currentPrice: 180,
    divestPercent: 0.5,
    horizonYears: 2,
    ordinaryIncome: 200_000,
    filingStatus: 'single',
    stateCode: 'CA',
    today: TODAY,
    ...over,
  };
}

describe('computeLotDivestPlan — pinned first-load state', () => {
  it('sells 50% (195 of 390) and the headline delta clears the $250 honesty floor', () => {
    const r = computeLotDivestPlan(base());
    expect(r.sharesToSell).toBe(195);
    expect(r.totalShares).toBe(390);
    expect(r.headlineDeltaVsFifo).toBeGreaterThan(250);
    expect(r.headlineDeltaVsFifo).toBeLessThan(6000);
  });
});

describe('invariants that hold for every input', () => {
  const inputs: [string, LotDivestInput][] = [
    ['default', base()],
    ['all now', base({ horizonYears: 1 })],
    ['3 years', base({ horizonYears: 3 })],
    ['100% divest', base({ divestPercent: 1 })],
    ['10% divest', base({ divestPercent: 0.1 })],
    ['MFJ / NY', base({ filingStatus: 'married_joint', stateCode: 'NY' })],
    ['no-tax state', base({ stateCode: 'TX' })],
  ];
  for (const [name, input] of inputs) {
    it(`${name}: headline delta ≥ 0 (FIFO-same-schedule never beats the plan)`, () => {
      const r = computeLotDivestPlan(input);
      expect(r.headlineDeltaVsFifo).toBeGreaterThanOrEqual(-1e-6);
    });
    it(`${name}: attribution telescopes (lotSelection + spreadingDeferral == total)`, () => {
      const r = computeLotDivestPlan(input);
      expect(r.attribution.lotSelection + r.attribution.spreadingDeferral).toBeCloseTo(
        r.attribution.total,
        4,
      );
    });
    it(`${name}: sells exactly the divest target`, () => {
      const r = computeLotDivestPlan(input);
      const sold = r.schedule.reduce((a, g) => a + g.sales.reduce((x, s) => x + s.shares, 0), 0);
      expect(sold).toBeCloseTo(r.sharesToSell, 6);
    });
    it(`${name}: after-tax + total tax == gross (accounting identity)`, () => {
      const r = computeLotDivestPlan(input);
      expect(r.totalAfterTax + r.totalTax).toBeCloseTo(r.totalGross, 2);
    });
  }
});

describe('specific-lot identification beats FIFO on pure gains', () => {
  it('prefers higher-basis (lower-gain) lots, so tax is below FIFO-oldest-first', () => {
    // All lots long-term, all gains; oldest lot has the LOWEST basis (biggest
    // gain). FIFO would sell it first and realize the most gain; the optimizer
    // should not.
    const r = computeLotDivestPlan(
      base({
        lots: [
          { vestDate: d('2020-01-15'), shares: 100, costBasisPerShare: 20 }, // oldest, biggest gain
          { vestDate: d('2021-01-15'), shares: 100, costBasisPerShare: 90 },
          { vestDate: d('2022-01-15'), shares: 100, costBasisPerShare: 150 }, // smallest gain
        ],
        horizonYears: 1,
        divestPercent: 1 / 3,
      }),
    );
    expect(r.headlineDeltaVsFifo).toBeGreaterThan(0);
    // The optimizer should sell the smallest-gain (highest-basis) shares.
    const soldLot2 = r.schedule
      .flatMap((g) => g.sales)
      .filter((s) => s.lotIndex === 2)
      .reduce((a, s) => a + s.shares, 0);
    expect(soldLot2).toBeGreaterThan(0);
  });
});

describe('loss harvesting lowers tax', () => {
  it('an underwater lot in the mix produces lower total tax than the same lots all in gain', () => {
    const withLoss = computeLotDivestPlan(
      base({
        lots: [
          { vestDate: d('2021-01-15'), shares: 100, costBasisPerShare: 40 },
          { vestDate: d('2026-05-15'), shares: 100, costBasisPerShare: 260 }, // underwater at 180
        ],
        divestPercent: 1,
        horizonYears: 1,
      }),
    );
    const noLoss = computeLotDivestPlan(
      base({
        lots: [
          { vestDate: d('2021-01-15'), shares: 100, costBasisPerShare: 40 },
          { vestDate: d('2026-05-15'), shares: 100, costBasisPerShare: 160 }, // small gain
        ],
        divestPercent: 1,
        horizonYears: 1,
      }),
    );
    expect(withLoss.totalTax).toBeLessThan(noLoss.totalTax);
  });
});

describe('schedule rows reconcile with the year subtotal (F5)', () => {
  const cases: [string, LotDivestInput][] = [
    ['default', base()],
    ['carryforward year (deep-loss lot + big gain, 2yr)', base({
      lots: [
        { vestDate: d('2021-01-15'), shares: 300, costBasisPerShare: 20 },
        { vestDate: d('2021-01-15'), shares: 100, costBasisPerShare: 400 }, // deep loss
      ],
      divestPercent: 1,
      horizonYears: 2,
    })],
    ['all-loss 1yr', base({
      lots: [
        { vestDate: d('2021-01-15'), shares: 100, costBasisPerShare: 300 },
        { vestDate: d('2021-06-15'), shares: 100, costBasisPerShare: 260 },
      ],
      divestPercent: 1,
      horizonYears: 1,
    })],
  ];
  for (const [name, input] of cases) {
    it(`${name}: per-row taxAttributed sums to group.tax`, () => {
      const r = computeLotDivestPlan(input);
      for (const g of r.schedule) {
        const rowSum = g.sales.reduce((a, s) => a + s.taxAttributed, 0);
        expect(rowSum).toBeCloseTo(g.tax, 4);
      }
    });
  }
});

describe('"Sell all now" means today (F4)', () => {
  it('horizon=1 schedules every sale on today, even for a near-long-term lot', () => {
    const today = d('2026-07-23');
    const r = computeLotDivestPlan(
      base({
        // vested 2025-09-01 -> long-term crossing 2026-09-02 (later this year)
        lots: [{ vestDate: d('2025-09-01'), shares: 200, costBasisPerShare: 100 }],
        divestPercent: 1,
        horizonYears: 1,
        today,
      }),
    );
    for (const g of r.schedule) {
      for (const s of g.sales) {
        expect(s.saleDate.getTime()).toBe(today.getTime());
      }
    }
  });
});

describe('single lot has nothing to optimize', () => {
  it('delta is ~0 with one lot (FIFO == optimizer)', () => {
    const r = computeLotDivestPlan(
      base({
        lots: [{ vestDate: d('2021-01-15'), shares: 500, costBasisPerShare: 50 }],
        divestPercent: 0.5,
      }),
    );
    expect(r.headlineDeltaVsFifo).toBeLessThan(1);
  });
});
