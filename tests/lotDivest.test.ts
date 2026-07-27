// AlphaLatitude Inc. © 2026
//
// Correctness tests for the RSU Lot Order engine (lotDivest.ts).

import { describe, it, expect } from 'vitest';
import {
  computeLotDivestPlan,
  candidateSaleDatesForTest,
  priceAllocationForTest,
  type LotDivestInput,
} from '../lib/calc/lotDivest';

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

// The results panel shows a DIFFERENT message for these two shapes than for a
// genuine "FIFO happened to be optimal" close call, because here no ordering
// decision exists at all. Both were verified $0 across a randomised sweep
// (single lot n=685, all-shares-one-year n=419, zero counter-examples); these
// pin the two the copy asserts so the message can't outlive the invariant.
describe('structurally zero savings (no ordering decision exists)', () => {
  const lots = [
    { vestDate: d('2021-01-15'), shares: 300, costBasisPerShare: 40 },
    { vestDate: d('2023-06-15'), shares: 200, costBasisPerShare: 120 },
    { vestDate: d('2025-09-15'), shares: 150, costBasisPerShare: 210 },
  ];

  it('selling every share inside one tax year cannot be improved by lot order', () => {
    const r = computeLotDivestPlan(base({ lots, divestPercent: 1, horizonYears: 1 }));
    expect(r.sharesToSell).toBeCloseTo(r.totalShares, 6);
    expect(r.schedule).toHaveLength(1);
    expect(r.headlineDeltaVsFifo).toBeLessThan(0.01);
  });

  it('a partial divest over the same lots DOES have something to optimize', () => {
    const r = computeLotDivestPlan(base({ lots, divestPercent: 0.5, horizonYears: 2 }));
    expect(r.headlineDeltaVsFifo).toBeGreaterThan(0);
  });
});

// Sweep guard for the greedy's pruned scan. The dominance argument itself is
// documented once, at the code it justifies (see greedyAssign in lotDivest.ts);
// what matters here is that these structural invariants hold across many shapes
// rather than the handful of fixtures above. The exhaustive-optimum oracle
// further down is what checks the pruning picks the RIGHT lot; this block checks
// the plan it produces is well-formed at all.
//
// Wider randomised sweeps and the brute-force comparison were run offline while
// developing the pruning; their results are recorded in
// docs/revisions/ClaudeDesign_Revision_152.md. Do not go looking for a harness
// in the repo - the committed guards are this block and the oracle below.
describe('greedy scan invariants (seeded sweep)', () => {
  // Deterministic LCG: same 200 scenarios on every run, no wall-clock or
  // Math.random dependency.
  let seed = 20260726;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

  const scenarios: LotDivestInput[] = Array.from({ length: 200 }, () => {
    const n = 1 + Math.floor(rnd() * 6);
    const price = 40 + rnd() * 200;
    return base({
      lots: Array.from({ length: n }, (_, i) => ({
        // Alternate underwater / deep-gain so loss harvesting, Schedule D
        // netting and the carryforward chain are all exercised.
        vestDate: new Date(Date.UTC(2026, 6 - pick([3, 8, 11, 12, 13, 26, 40, 70]), 1 + Math.floor(rnd() * 27))),
        shares: 5 + Math.floor(rnd() * 300),
        costBasisPerShare: Math.max(1, price * (i % 2 === 0 ? 1.1 + rnd() * 1.1 : 0.05 + rnd() * 0.9)),
      })),
      currentPrice: price,
      divestPercent: pick([0.1, 0.25, 0.5, 0.75, 1]),
      horizonYears: pick([1, 2, 3]),
      ordinaryIncome: pick([0, 48_000, 200_000, 250_000, 547_800, 616_250]),
      filingStatus: pick(['single', 'married_joint', 'head_household'] as const),
      stateCode: pick(['CA', 'NY', 'TX', 'SC', 'NJ', 'PA']),
    });
  });

  // Solve once and share; each `it` below re-derived the same 200 plans.
  const solved = scenarios.map((input, i) => ({ i, input, r: computeLotDivestPlan(input) }));

  it('never loses to the FIFO baseline on the same schedule', () => {
    for (const { i, r } of solved) {
      // NOT headlineDeltaVsFifo: that is Math.max(0, ...), so asserting it is
      // non-negative holds by construction and can only fail on NaN. The
      // unclamped quantity is total - spreadingDeferral, which goes negative
      // precisely when the clamp fires (i.e. when the plan lost to FIFO).
      const unclamped = r.attribution.total - r.attribution.spreadingDeferral;
      expect(unclamped, `scenario ${i}`).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it('attribution telescopes in every scenario', () => {
    for (const { i, r } of solved) {
      const a = r.attribution;
      expect(a.lotSelection + a.spreadingDeferral, `scenario ${i}`).toBeCloseTo(a.total, 2);
    }
  });

  it('sells exactly the requested share count, never more than a lot holds', () => {
    for (const { i, input, r } of solved) {
      const sold = r.schedule.flatMap((g) => g.sales);
      const totalSold = sold.reduce((acc, s) => acc + s.shares, 0);
      expect(totalSold, `scenario ${i}`).toBeCloseTo(r.sharesToSell, 6);
      const perLot = new Map<number, number>();
      for (const s of sold) perLot.set(s.lotIndex, (perLot.get(s.lotIndex) ?? 0) + s.shares);
      for (const [lotIndex, shares] of perLot) {
        expect(shares, `scenario ${i}, lot ${lotIndex}`).toBeLessThanOrEqual(
          input.lots[lotIndex].shares + 1e-6,
        );
      }
    }
  });

  it('year subtotals reconcile with the row attributions', () => {
    for (const { i, r } of solved) {
      for (const g of r.schedule) {
        const rows = g.sales.reduce((acc, s) => acc + s.taxAttributed, 0);
        expect(rows, `scenario ${i}, year ${g.year}`).toBeCloseTo(g.tax, 2);
      }
    }
  });
});

// The greedy prunes its scan with a dominance argument (see greedyAssign): only
// the lowest-gain lot in each (sale date, long/short) bucket can win, so the
// rest are never priced. That argument is load-bearing and unproven. If a future
// tax rule makes plan tax non-monotone in realized gain, or a same-date tie is
// resolved by the wrong rule, the engine silently picks a worse lot and still
// returns a plausible plan — every one of the tests above passed on a version
// that overstated tax by $5,295 on a 7-lot input.
//
// So: score the engine against an EXHAUSTIVE optimum. Instances are kept tiny so
// every feasible integer allocation can be enumerated and priced with the
// engine's own tax function, making this a true oracle rather than a
// second opinion.
describe('matches the exhaustive optimum (guards the dominance pruning)', () => {
  function exhaustiveMinTax(input: LotDivestInput, S: number): number {
    const nDates = candidateSaleDatesForTest(input).length;
    const nLots = input.lots.length;
    const caps = input.lots.map((l) => l.shares);
    const x: number[][] = Array.from({ length: nLots }, () => new Array<number>(nDates).fill(0));
    const cells: [number, number][] = [];
    for (let i = 0; i < nLots; i += 1) for (let c = 0; c < nDates; c += 1) cells.push([i, c]);
    let best = Infinity;
    const used = new Array<number>(nLots).fill(0);
    const rec = (k: number, left: number) => {
      if (k === cells.length) {
        if (left === 0) best = Math.min(best, priceAllocationForTest(input, x));
        return;
      }
      const [i, c] = cells[k];
      const room = Math.min(left, caps[i] - used[i]);
      for (let v = 0; v <= room; v += 1) {
        x[i][c] = v;
        used[i] += v;
        rec(k + 1, left - v);
        used[i] -= v;
        x[i][c] = 0;
      }
    };
    rec(0, S);
    return best;
  }

  // [name, input, maxExcess] — maxExcess is how far above the exhaustive optimum
  // this input is ALLOWED to land. The greedy is near-optimal, not exact (see
  // revision memo 152), so pinning a per-case budget documents the real quality
  // bound and fails if it ever widens, which asserting equality could not do.
  const cases: [string, LotDivestInput, number][] = [
    ['gains only, 2 dates', base({
      lots: [
        { vestDate: d('2020-03-10'), shares: 4, costBasisPerShare: 30 },
        { vestDate: d('2023-09-01'), shares: 4, costBasisPerShare: 150 },
      ],
      divestPercent: 0.5, horizonYears: 2,
    }), 0.01],
    ['loss + gain, offset in play', base({
      lots: [
        { vestDate: d('2021-05-05'), shares: 3, costBasisPerShare: 20 },
        { vestDate: d('2026-01-20'), shares: 3, costBasisPerShare: 400 },
      ],
      divestPercent: 0.67, horizonYears: 2, ordinaryIncome: 48_000,
      // Known gap: the greedy lands $0.19 above the true optimum here, on a
      // net-loss plan worth about -$109. Left in deliberately as the honest
      // record that this is a heuristic, not an exact solver.
    }), 0.25],
    // The shape the adversarial review broke: an already-long-term lot and a
    // not-yet-long-term lot with the SAME gain per share, so they tie on
    // marginal tax and the tie-break decides. Picking the short-term lot
    // forfeits the deferral its remaining shares still had available.
    ['LT/ST tie at equal gain per share', base({
      lots: [
        { vestDate: d('2024-10-18'), shares: 3, costBasisPerShare: 180 },
        { vestDate: d('2026-06-28'), shares: 5, costBasisPerShare: 180 },
      ],
      currentPrice: 900, divestPercent: 0.5, horizonYears: 3, ordinaryIncome: 2_000,
    }), 0.01],
    ['all underwater', base({
      lots: [
        { vestDate: d('2021-02-02'), shares: 3, costBasisPerShare: 300 },
        { vestDate: d('2022-02-02'), shares: 3, costBasisPerShare: 260 },
      ],
      divestPercent: 0.5, horizonYears: 2, ordinaryIncome: 0,
    }), 0.01],
  ];

  for (const [name, input, maxExcess] of cases) {
    it(`${name}: within $${maxExcess} of the exhaustive optimum`, () => {
      const r = computeLotDivestPlan(input);
      const optimum = exhaustiveMinTax(input, Math.round(r.sharesToSell));
      expect(Number.isFinite(optimum)).toBe(true);
      // Never BELOW the optimum: that would mean the plan is infeasible (selling
      // shares a lot does not hold), which is exactly how the swapPass bug showed
      // up before it was fixed.
      expect(r.totalTax).toBeGreaterThanOrEqual(optimum - 0.01);
      expect(r.totalTax - optimum).toBeLessThanOrEqual(maxExcess);
    });
  }

  // The reviewer's minimized counterexample, at full size. Pinned as a value so
  // a regression shows the dollar cost rather than an abstract inequality.
  it('the LT/ST tie regression stays fixed ($90 of overstated tax)', () => {
    const r = computeLotDivestPlan(base({
      lots: [
        { vestDate: d('2025-10-14'), shares: 1, costBasisPerShare: 4500 },
        { vestDate: d('2024-10-18'), shares: 68, costBasisPerShare: 180 },
        { vestDate: d('2026-06-28'), shares: 198, costBasisPerShare: 180 },
      ],
      currentPrice: 900, divestPercent: 0.75, horizonYears: 3,
      ordinaryIncome: 2_000, today: d('2026-07-26'),
    }));
    expect(r.totalTax).toBeCloseTo(4398.27, 2);
  });
});

// swapPass may re-time a lot's OWN shares between sale dates. Its inventory
// guard used to block that (a fully-sold lot has inv === 0, so every candidate
// move failed the "does the destination have room" test) even though moving a
// lot's shares from one of its own dates to another consumes no inventory at
// all. That excluded exactly the lot most likely to benefit.
//
// Enabling it improved 312 of 12,000 targeted instances (fully-sold lots with
// their shares split across dates, vest dates straddling the one-year mark),
// mean $188, max $426, no malformed schedules. It is invisible to a uniform
// random sweep, which rarely produces that shape.
//
// It is NOT a strict improvement, and an earlier version of this comment
// wrongly claimed zero regressions. swapPass is a first-improvement hill
// climber: widening its neighbourhood can make it take a different first move
// and descend to a different local optimum. Both optima sit below the plan it
// started from (swapPass never raises tax against its own input, since baseTax
// is recomputed each pass and moves are only accepted below it), but the new
// one can sit above the old. Adversarial review found ~1 regression per 6,000
// targeted instances and none in 2,000 uniform ones, worst observed $41.79 from
// sweeping and $83.73 on a deliberately hill-climbed input. Against that, one
// 8,000-case aggregate showed 111 improvements totalling $13,790 versus a single
// $8.69 regression. The asymmetry is why this ships, not a guarantee that it
// never costs anything.
describe('swapPass can re-time a fully-sold lot across its own sale dates', () => {
  it('harvests $252 more loss than the pre-fix plan on a fully-divested pair', () => {
    const r = computeLotDivestPlan(base({
      lots: [
        { vestDate: d('2025-05-02'), shares: 85, costBasisPerShare: 113.2471 },
        { vestDate: d('2025-05-11'), shares: 51, costBasisPerShare: 41.8941 },
      ],
      currentPrice: 90.7757,
      divestPercent: 1,
      horizonYears: 2,
      ordinaryIncome: 20_000,
      filingStatus: 'single',
      stateCode: 'SC',
      today: d('2026-07-26'),
    }));
    // Pre-fix this plan priced at -$3.44; the re-timed plan realizes far more of
    // the loss inside the horizon. A negative total tax is a net credit against
    // other income, so MORE negative is better.
    expect(r.totalTax).toBeLessThan(-250);
    expect(r.totalTax).toBeCloseTo(-255.85, 1);
  });
});
