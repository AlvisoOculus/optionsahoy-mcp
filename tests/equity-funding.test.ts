// AlphaLatitude Inc. © 2026
//
// Wiring tests for the equity_funding_optimize tool: the MCP-side parser
// honors the documented schema (multi-stack lots, optional ticker, optional
// per-stack volatility), translates raw JSON into the calc's typed input,
// and the calc returns the four named plans the tool description promises.
// Math correctness is exercised by the existing 71-test suite in
// optionsahoy_web/web/lib/calc/equityFunding.test.ts; here we only verify
// the integration is wired correctly.

import { describe, it, expect } from 'vitest';
import { parseEquityFundingInput } from '../functions/_lib/calc-parsers';
import { computeEquityFundingComparison } from '../lib/calc/equityFunding';
import { getTrailingReturn } from '../lib/data/trailing-returns';

const BASE = {
  targetAfterTax: 200_000,
  targetDate: '2028-06-01',
  today: '2026-06-01',
  ordinaryIncome: 250_000,
  filingStatus: 'single',
  stateCode: 'CA',
  cashInterestRate: 0.04,
  stacks: [
    {
      currentPrice: 100,
      expectedAnnualGrowth: 0.08,
      lots: [
        { shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' },
      ],
    },
  ],
};

describe('parseEquityFundingInput', () => {
  it('parses a minimal valid input and the calc returns 4 named plans', () => {
    const input = parseEquityFundingInput(BASE);
    expect(input.stacks).toBeDefined();
    expect(input.stacks!.length).toBe(1);
    expect(input.stacks![0]!.lots.length).toBe(1);
    expect(input.stacks![0]!.expectedAnnualGrowth).toBe(0.08);

    const out = computeEquityFundingComparison(input);
    expect(out.recommended).toBeDefined();
    expect(out.lockInNow).toBeDefined();
    expect(out.balanced).toBeDefined();
    expect(out.holdForGrowth).toBeDefined();
    expect(Array.isArray(out.frontier)).toBe(true);
  });

  it('resolves stack expectedAnnualGrowth from ticker when omitted', () => {
    const nvdaCagr = getTrailingReturn('NVDA', 2);
    expect(nvdaCagr).not.toBeNull();
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          ticker: 'NVDA',
          currentPrice: 100,
          lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
        },
      ],
    });
    expect(input.stacks![0]!.expectedAnnualGrowth).toBeCloseTo(nvdaCagr!, 6);
  });

  it('explicit expectedAnnualGrowth beats ticker', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          ticker: 'NVDA',
          currentPrice: 100,
          expectedAnnualGrowth: 0.15,
          lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
        },
      ],
    });
    expect(input.stacks![0]!.expectedAnnualGrowth).toBe(0.15);
  });

  it('throws on unknown ticker without explicit growth', () => {
    expect(() =>
      parseEquityFundingInput({
        ...BASE,
        stacks: [
          {
            ticker: 'FAKENAME',
            currentPrice: 100,
            lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
          },
        ],
      }),
    ).toThrow(/stacks\[0\]\.expectedAnnualGrowth/);
  });

  it('allows omitted growth without ticker (defaults to flat)', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          currentPrice: 100,
          lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
        },
      ],
    });
    expect(input.stacks![0]!.expectedAnnualGrowth).toBeUndefined();
  });

  it('captures per-stack volatility into stackVolatilities array', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          currentPrice: 100,
          expectedAnnualGrowth: 0.08,
          volatility: 0.45,
          lots: [{ shares: 3000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' }],
        },
        {
          currentPrice: 50,
          expectedAnnualGrowth: 0.05,
          lots: [{ shares: 2000, costBasisPerShare: 10, acquisitionDate: '2023-01-15' }],
        },
      ],
    });
    expect(input.stackVolatilities).toEqual([0.45, null]);
  });

  it('omits stackVolatilities when no stack supplies a vol', () => {
    const input = parseEquityFundingInput(BASE);
    expect(input.stackVolatilities).toBeUndefined();
  });

  it('parses optional vestDate on a lot', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      stacks: [
        {
          currentPrice: 100,
          expectedAnnualGrowth: 0.08,
          lots: [
            { shares: 1000, costBasisPerShare: 20, acquisitionDate: '2022-03-15' },
            { shares: 500, costBasisPerShare: 0, acquisitionDate: '2027-01-01', vestDate: '2027-01-01' },
          ],
        },
      ],
    });
    expect(input.stacks![0]!.lots[1]!.vestDate).toBeInstanceOf(Date);
  });

  it('rejects empty stacks array', () => {
    expect(() => parseEquityFundingInput({ ...BASE, stacks: [] })).toThrow(/stacks.*non-empty/);
  });

  it('rejects empty lots array on a stack', () => {
    expect(() =>
      parseEquityFundingInput({
        ...BASE,
        stacks: [{ currentPrice: 100, expectedAnnualGrowth: 0.08, lots: [] }],
      }),
    ).toThrow(/stacks\[0\]\.lots.*non-empty/);
  });

  it('forwards riskToleranceShortfall and defaultVolatility', () => {
    const input = parseEquityFundingInput({
      ...BASE,
      riskToleranceShortfall: 0.05,
      defaultVolatility: 0.50,
    });
    expect(input.riskToleranceShortfall).toBe(0.05);
    expect(input.defaultVolatility).toBe(0.50);
  });
});
