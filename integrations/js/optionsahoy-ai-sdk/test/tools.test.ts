// AlphaLatitude Inc. © 2026
//
// Unit tests. No network: a fake fetch is injected via the tool factory and
// records the URL + payload each `execute` builds.

import { describe, expect, it, vi } from 'vitest';

import {
  createOptionsAhoyTools,
  optionsAhoyTools,
  type OptionsAhoyToolName,
} from '../src/index.js';
import type { FetchLike } from '../src/client.js';

/** Canonical tool name -> REST slug the endpoint POSTs to. */
const TOOL_SLUGS: Record<OptionsAhoyToolName, string> = {
  amt_iso_optimize: 'amt-iso',
  nso_calculate: 'nso',
  rsu_sell_vs_hold: 'rsu-sell-vs-hold',
  concentration_analyze: 'concentration',
  protective_put_price: 'protective-put',
  qsbs_check: 'qsbs',
  equity_funding_plan: 'equity-funding',
  rsu_lot_optimize: 'rsu-lot-order',
};

const TOOL_NAMES = Object.keys(TOOL_SLUGS) as OptionsAhoyToolName[];

/** A fetch stub that always returns `{ ok: true, result }` and records the call. */
function stubFetch(result: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result }),
    };
  });
  return { fetch, calls };
}

// A minimal placeholder payload for each tool. Values are not validated by
// `execute` (the AI SDK validates against `parameters` at call time); the point
// is to confirm the payload is forwarded verbatim to the right endpoint.
const SAMPLE_ARGS: Record<OptionsAhoyToolName, Record<string, unknown>> = {
  amt_iso_optimize: { shares: 1000, strike: 2, fmv: 40, ticker: 'NVDA' },
  nso_calculate: { shares: 500, strike: 5, currentPrice: 50 },
  rsu_sell_vs_hold: { shares: 100, currentPrice: 100, ticker: 'MSFT' },
  concentration_analyze: { positionValue: 400000, totalAssets: 1200000 },
  protective_put_price: { positionValue: 400000, protectionLevel: 0.1, tenorYears: 1 },
  qsbs_check: { acquisitionDate: '2020-01-15', saleDate: '2026-06-01' },
  equity_funding_plan: { targetAfterTax: 400000, targetDate: '2028-06-01' },
  rsu_lot_optimize: {
    lots: [
      { vestDate: '2022-08-15', shares: 120, costBasisPerShare: 95 },
      { vestDate: '2024-02-15', shares: 100, costBasisPerShare: 130 },
      { vestDate: '2026-05-15', shares: 80, costBasisPerShare: 210 },
    ],
    currentPrice: 180,
    divestFraction: 0.5,
    horizonYears: 2,
    ordinaryIncome: 200000,
    filingStatus: 'single',
    stateCode: 'CA',
  },
};

describe('createOptionsAhoyTools', () => {
  it('exports exactly the eight calculators', () => {
    const tools = createOptionsAhoyTools();
    expect(Object.keys(tools).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Object.keys(optionsAhoyTools).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('each tool has a description and a zod parameters schema', () => {
    const tools = createOptionsAhoyTools();
    for (const name of TOOL_NAMES) {
      const t = tools[name];
      expect(typeof t.description).toBe('string');
      expect((t.description ?? '').length).toBeGreaterThan(20);
      expect(t.parameters).toBeDefined();
      // A zod schema exposes safeParse.
      expect(typeof (t.parameters as { safeParse?: unknown }).safeParse).toBe('function');
      expect(typeof t.execute).toBe('function');
    }
  });

  it('execute POSTs to the right keyless URL with the args as the JSON body', async () => {
    for (const name of TOOL_NAMES) {
      const { fetch, calls } = stubFetch({ echoed: name });
      const tools = createOptionsAhoyTools({ fetch });
      const args = SAMPLE_ARGS[name];

      const result = await tools[name].execute!(args as never, {
        toolCallId: 'test',
        messages: [],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`https://optionsahoy.com/api/v1/${TOOL_SLUGS[name]}`);
      expect(calls[0].body).toEqual(args);
      expect(result).toEqual({ echoed: name });
    }
  });

  it('honors a custom baseURL', async () => {
    const { fetch, calls } = stubFetch({ ok: 1 });
    const tools = createOptionsAhoyTools({ fetch, baseURL: 'https://staging.example.com/' });
    await tools.qsbs_check.execute!({ acquisitionDate: '2020-01-01' } as never, {
      toolCallId: 'test',
      messages: [],
    });
    expect(calls[0].url).toBe('https://staging.example.com/api/v1/qsbs');
  });

  it('throws with the API error message on an ok:false envelope', async () => {
    const fetch: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'missing required field: strike' }),
    }));
    const tools = createOptionsAhoyTools({ fetch });
    await expect(
      tools.nso_calculate.execute!({ shares: 1 } as never, { toolCallId: 't', messages: [] }),
    ).rejects.toThrow('missing required field: strike');
  });
});
