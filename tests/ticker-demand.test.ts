// AlphaLatitude Inc. © 2026
//
// Daily ticker counts (functions/_lib/ticker-demand.ts) are the demand signal
// for market-data coverage: which symbols callers name, and whether we could
// serve them. Unit rules first, then end to end through the real MCP handler,
// which is also where the "no figures stored" promise has to hold.

import { describe, it, expect } from 'vitest';
import { namedTickers, tickerUses } from '../functions/_lib/ticker-demand';
import { onRequest } from '../functions/mcp';
import type { D1Database, D1PreparedStatement } from '../functions/_lib/stats';

describe('namedTickers', () => {
  it('reads `ticker` and every `stacks[].ticker`, upper-cased and de-duplicated', () => {
    expect(namedTickers({ ticker: 'nvda', stacks: [{ ticker: 'AAPL' }, { ticker: ' nvda ' }, {}] })).toEqual([
      'NVDA',
      'AAPL',
    ]);
  });

  it('accepts JSON text (the A2A envelope arrives as a string)', () => {
    expect(namedTickers('{"ticker":"BRK.B"}')).toEqual(['BRK.B']);
  });

  it('skips the "market" sentinel, which names no company', () => {
    expect(namedTickers({ ticker: 'market' })).toEqual([]);
  });

  it('skips anything that is not a plausible symbol, so no free text lands in the table', () => {
    expect(namedTickers({ ticker: 'my company, about 412345 shares' })).toEqual([]);
    expect(namedTickers({ ticker: 42 })).toEqual([]);
    expect(namedTickers('not json')).toEqual([]);
    expect(namedTickers(null)).toEqual([]);
  });
});

describe('tickerUses outcomes', () => {
  it('marks every named ticker "error" when the call failed', () => {
    expect(tickerUses({ ticker: 'NVDA' }, null, true)).toEqual([{ ticker: 'NVDA', outcome: 'error' }]);
  });

  it('"fallback" when a growth assumption names the ticker', () => {
    const result = {
      assumptions: [{ field: 'expectedGrowth', reason: 'could not be derived from ticker "zzzz" (no trailing returns for it)' }],
    };
    expect(tickerUses({ ticker: 'ZZZZ' }, result, false)).toEqual([{ ticker: 'ZZZZ', outcome: 'fallback' }]);
  });

  it('"fallback" when a hedge was priced at a sector-typical volatility', () => {
    const result = { inputs: { volatilitySource: 'sector-default' } };
    expect(tickerUses({ ticker: 'ZZZZ' }, result, false)).toEqual([{ ticker: 'ZZZZ', outcome: 'fallback' }]);
  });

  it('"ok" otherwise, and per ticker: one stack can fall back while another is served', () => {
    const result = { assumptions: [{ reason: 'could not be derived from ticker "ZZZZ" (no trailing returns for it)' }] };
    expect(tickerUses({ stacks: [{ ticker: 'NVDA' }, { ticker: 'ZZZZ' }] }, result, false)).toEqual([
      { ticker: 'NVDA', outcome: 'ok' },
      { ticker: 'ZZZZ', outcome: 'fallback' },
    ]);
  });
});

// ── End to end through functions/mcp.ts ──────────────────────────────────────

interface Stmt {
  sql: string;
  bindings: unknown[];
}

function recordingDb(): { db: D1Database; stmts: Stmt[] } {
  const stmts: Stmt[] = [];
  const prepare = (sql: string): D1PreparedStatement => {
    const entry: Stmt = { sql, bindings: [] };
    const obj: D1PreparedStatement = {
      bind(...values: unknown[]) {
        entry.bindings = values;
        return obj;
      },
      async run() {
        stmts.push(entry);
        return undefined;
      },
      async all<T = unknown>() {
        return { results: [] as T[] };
      },
    };
    return obj;
  };
  return { db: { prepare }, stmts };
}

async function call(name: string, args: Record<string, unknown>): Promise<Stmt[]> {
  const { db, stmts } = recordingDb();
  const pending: Promise<unknown>[] = [];
  await onRequest({
    request: new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Claude-User' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    env: { MCP_STATS: db },
    waitUntil: (p) => {
      pending.push(p);
    },
  });
  await Promise.all(pending);
  return stmts;
}

const tickerRows = (stmts: Stmt[]) =>
  stmts.filter((s) => s.sql.startsWith('INSERT INTO mcp_ticker_daily')).map((s) => s.bindings.slice(1));

const PUT = {
  positionValue: 412345,
  sector: 'tech_software',
  protectionLevel: 0.2,
  tenorYears: 1,
  volatility: 0.37,
  ticker: 'NVDA',
};

describe('through the MCP handler', () => {
  it('counts a served ticker as ok', async () => {
    expect(tickerRows(await call('protective_put_price', PUT))).toEqual([['NVDA', 'protective_put_price', 'ok']]);
  });

  it('counts the ticker on a failed call too: that is where uncovered symbols show up', async () => {
    const { positionValue: _omit, ...missing } = PUT;
    expect(tickerRows(await call('protective_put_price', missing))).toEqual([['NVDA', 'protective_put_price', 'error']]);
  });

  it('counts a ticker with no growth data as a fallback', async () => {
    const stmts = await call('amt_iso_optimize', {
      shares: 1000, strike: 5, fmv: 40, horizon: 3, volatility: 0.4, ticker: 'ZZZZ',
      filingStatus: 'single', ordinaryIncome: 200000, stateCode: 'CA', carryforwardCredit: 0,
      cashReturnRate: 0.05, grantDate: '2024-01-15', hasLeftCompany: false,
    });
    expect(tickerRows(stmts)).toEqual([['ZZZZ', 'amt_iso_optimize', 'fallback']]);
  });

  it('writes nothing for a call that names no ticker', async () => {
    const { ticker: _t, ...noTicker } = PUT;
    expect(tickerRows(await call('protective_put_price', noTicker))).toEqual([]);
  });

  it('stores the call shape in mcp_samples, with none of the figures', async () => {
    const stmts = await call('protective_put_price', PUT);
    const sample = stmts.find((s) => s.sql.startsWith('INSERT INTO mcp_samples'))!;
    const stored = JSON.stringify(sample.bindings);
    for (const figure of ['412345', '0.37', '0.2', 'tech_software', 'NVDA']) expect(stored).not.toContain(figure);
    expect(JSON.parse(sample.bindings[4] as string)).toMatchObject({ positionValue: 'number', ticker: 'string' });
    expect(sample.bindings[5]).toBeNull();
  });
});
