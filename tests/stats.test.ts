// AlphaLatitude Inc. © 2026
//
// Unit tests for functions/_lib/stats.ts. Verifies the logger:
//   - is a silent no-op when env.MCP_STATS is missing (local dev, tests)
//   - inserts one row per call with all expected fields
//   - truncates oversized UA / error_msg / client_name
//   - swallows D1 errors so a logger failure can't break a calc response
//   - hands the run() promise to waitUntil when present

import { describe, it, expect, vi } from 'vitest';
import {
  logCall,
  logCalls,
  logSample,
  logSamples,
  type D1Database,
  type D1PreparedStatement,
  type PagesContext,
} from '../functions/_lib/stats';

interface Recorded { sql: string; bindings: unknown[] }

function mockDb(opts: { fail?: boolean } = {}): { db: D1Database; recorded: Recorded[]; runs: number } {
  const recorded: Recorded[] = [];
  let runs = 0;
  const stmt = (sql: string): D1PreparedStatement => {
    const entry: Recorded = { sql, bindings: [] };
    const obj: D1PreparedStatement = {
      bind(...values: unknown[]) {
        entry.bindings = values;
        return obj;
      },
      async run() {
        runs += 1;
        recorded.push(entry);
        if (opts.fail) throw new Error('D1 down');
        return undefined;
      },
      async all<T = unknown>() {
        return { results: [] as T[] };
      },
    };
    return obj;
  };
  return {
    db: { prepare: stmt },
    recorded,
    get runs() { return runs; },
  };
}

function ctx(opts: { db?: D1Database; ua?: string; country?: string } = {}): PagesContext & { waited: Promise<unknown>[] } {
  const headers = new Headers();
  if (opts.ua !== undefined) headers.set('user-agent', opts.ua);
  if (opts.country !== undefined) headers.set('cf-ipcountry', opts.country);
  const waited: Promise<unknown>[] = [];
  return {
    request: new Request('http://localhost/mcp', { method: 'POST', headers }),
    env: opts.db ? { MCP_STATS: opts.db } : {},
    waitUntil: (p: Promise<unknown>) => { waited.push(p); },
    waited,
  };
}

describe('logCall', () => {
  it('is a no-op when MCP_STATS binding is missing', () => {
    const c = ctx();
    expect(() => logCall(c, { endpoint: 'mcp:initialize', isError: false })).not.toThrow();
    expect(c.waited).toHaveLength(0);
  });

  it('inserts a row with all fields when binding is present', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db, ua: 'TestAgent/1.0', country: 'US' });
    logCall(c, {
      endpoint: 'mcp:tools/call',
      tool: 'concentration_analyze',
      isError: false,
      clientName: 'Claude.ai',
    });
    await Promise.all(c.waited);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].sql).toMatch(/INSERT INTO mcp_calls/);
    const b = recorded[0].bindings;
    expect(typeof b[0]).toBe('number');
    expect(b[1]).toBe('mcp:tools/call');
    expect(b[2]).toBe('concentration_analyze');
    expect(b[3]).toBe(0);
    expect(b[4]).toBeNull();
    expect(b[5]).toBe('Claude.ai');
    expect(b[6]).toBe('TestAgent/1.0');
    expect(b[7]).toBe('US');
  });

  // The proxy worker stamps the REAL caller's network metadata as
  // x-oa-client-* headers; this deployment's own request.cf is the worker's
  // egress (always Cloudflare/Dallas) and must lose to them. Regression for
  // the blind spot that hid every real client behind "Cloudflare, Inc.".
  it('prefers x-oa-client-* forwarded headers over cf-ipcountry/request.cf', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db, country: 'US' }); // cf-ipcountry says US (worker egress)
    c.request.headers.set('x-oa-client-country', 'DE');
    c.request.headers.set('x-oa-client-region', 'Bavaria');
    c.request.headers.set('x-oa-client-city', 'Munich');
    c.request.headers.set('x-oa-client-as-org', 'Hetzner Online GmbH');
    c.request.headers.set('x-oa-client-asn', '24940');
    logCall(c, { endpoint: 'mcp:tools/call', tool: 'nso_calculate', isError: false });
    await Promise.all(c.waited);
    const b = recorded[0].bindings;
    // country, as_org, asn, region, city columns (INSERT order)
    expect(b[7]).toBe('DE');
    expect(b[8]).toBe('Hetzner Online GmbH');
    expect(b[9]).toBe(24940);
    expect(b[10]).toBe('Bavaria');
    expect(b[11]).toBe('Munich');
  });

  it('a non-numeric forwarded asn falls back to null, other headers still win', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    c.request.headers.set('x-oa-client-asn', 'not-a-number');
    c.request.headers.set('x-oa-client-country', 'FR');
    logCall(c, { endpoint: 'mcp:tools/call', tool: 'nso_calculate', isError: false });
    await Promise.all(c.waited);
    const b = recorded[0].bindings;
    expect(b[7]).toBe('FR');
    expect(b[9]).toBeNull();
  });

  it('passes is_error=1 and the truncated error message', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    const longErr = 'x'.repeat(800);
    logCall(c, { endpoint: 'mcp:tools/call', tool: 'amt_iso_optimize', isError: true, errorMsg: longErr });
    await Promise.all(c.waited);
    expect(recorded[0].bindings[3]).toBe(1);
    expect((recorded[0].bindings[4] as string).length).toBe(500);
  });

  it('truncates oversized UA and client_name', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db, ua: 'a'.repeat(400) });
    logCall(c, { endpoint: 'mcp:initialize', isError: false, clientName: 'c'.repeat(200) });
    await Promise.all(c.waited);
    expect((recorded[0].bindings[5] as string).length).toBe(100);
    expect((recorded[0].bindings[6] as string).length).toBe(200);
  });

  it('swallows D1 failures so a logger error never throws', async () => {
    const { db } = mockDb({ fail: true });
    const c = ctx({ db });
    expect(() => logCall(c, { endpoint: 'mcp:tools/list', isError: false })).not.toThrow();
    // The promise was handed to waitUntil; awaiting it must not reject.
    await expect(Promise.all(c.waited)).resolves.toBeDefined();
  });

  it('hands the run() promise to ctx.waitUntil when present', () => {
    const { db } = mockDb();
    const waitUntil = vi.fn();
    const c: PagesContext = {
      request: new Request('http://localhost/mcp', { method: 'POST' }),
      env: { MCP_STATS: db },
      waitUntil,
    };
    logCall(c, { endpoint: 'mcp:ping', isError: false });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it('does not throw when waitUntil is absent', () => {
    const { db } = mockDb();
    const c: PagesContext = {
      request: new Request('http://localhost/mcp', { method: 'POST' }),
      env: { MCP_STATS: db },
      // no waitUntil
    };
    expect(() => logCall(c, { endpoint: 'mcp:ping', isError: false })).not.toThrow();
  });
});

describe('logCalls (batch)', () => {
  it('is a no-op on an empty batch', () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logCalls(c, []);
    expect(recorded).toHaveLength(0);
    expect(c.waited).toHaveLength(0);
  });

  it('uses db.batch() once when the binding exposes it', async () => {
    const { db, recorded } = mockDb();
    const batch = vi.fn(async (stmts: D1PreparedStatement[]) => {
      // Mirror what the production D1.batch() does: run each statement.
      for (const s of stmts) await s.run();
    });
    const dbWithBatch: D1Database = { ...db, batch };
    const c = ctx({ db: dbWithBatch });
    logCalls(c, [
      { endpoint: 'mcp:initialize', isError: false },
      { endpoint: 'mcp:tools/list', isError: false },
      { endpoint: 'mcp:tools/call', tool: 'qsbs_check', isError: false },
    ]);
    await Promise.all(c.waited);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(3);
    expect(recorded).toHaveLength(3);
  });

  it('falls back to per-statement run() when batch is absent', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logCalls(c, [
      { endpoint: 'mcp:tools/list', isError: false },
      { endpoint: 'mcp:tools/call', tool: 'amt_iso_optimize', isError: false },
    ]);
    await Promise.all(c.waited);
    expect(recorded).toHaveLength(2);
  });

  it('uses one timestamp for every row in a batch', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logCalls(c, [
      { endpoint: 'mcp:initialize', isError: false },
      { endpoint: 'mcp:tools/call', tool: 'qsbs_check', isError: false },
      { endpoint: 'mcp:tools/call', tool: 'nso_calculate', isError: false },
    ]);
    await Promise.all(c.waited);
    const timestamps = recorded.map((r) => r.bindings[0]);
    expect(new Set(timestamps).size).toBe(1);
  });
});

describe('logSample (example capture)', () => {
  it('is a no-op without the MCP_STATS binding', () => {
    const c = ctx({}); // no db
    expect(() => logSample(c, { surface: 'poe', args: { shares: 1 } })).not.toThrow();
    expect(c.waited).toHaveLength(0);
  });

  it('writes one mcp_samples insert + a 7-day prune, hands promise to waitUntil', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logSample(c, { surface: 'poe', tool: 'qsbs_check', clientName: 'poe', args: { shares: 50000 } });
    expect(c.waited).toHaveLength(1);
    await Promise.all(c.waited);

    const inserts = recorded.filter((r) => r.sql.startsWith('INSERT INTO mcp_samples'));
    const prunes = recorded.filter((r) => r.sql.startsWith('DELETE FROM mcp_samples'));
    expect(inserts).toHaveLength(1);
    expect(prunes).toHaveLength(1);

    const b = inserts[0].bindings; // ts, surface, tool, client_name, query, answer
    expect(b[1]).toBe('poe');
    expect(b[2]).toBe('qsbs_check');

    const cutoff = prunes[0].bindings[0] as number;
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(cutoff).toBeGreaterThan(Date.now() - 8 * 86_400_000); // ~7 days back
  });

  it('falls back to the request User-Agent as the client when none is given', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db, ua: 'curl/8.1.2' });
    logSample(c, { surface: 'rest', tool: 'equity-funding', args: {} });
    await Promise.all(c.waited);
    const insert = recorded.find((r) => r.sql.startsWith('INSERT INTO mcp_samples'))!;
    expect(insert.bindings[3]).toBe('curl/8.1.2'); // client_name = UA
  });

  it('keeps an explicit clientName over the User-Agent', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db, ua: 'curl/8.1.2' });
    logSample(c, { surface: 'poe', clientName: 'poe', args: {} });
    await Promise.all(c.waited);
    const insert = recorded.find((r) => r.sql.startsWith('INSERT INTO mcp_samples'))!;
    expect(insert.bindings[3]).toBe('poe');
  });

  it('skips our own smoke suite so it never pollutes the capture', () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db, ua: 'OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)' });
    logSample(c, { surface: 'rest', tool: 'qsbs', args: {} });
    expect(c.waited).toHaveLength(0); // nothing scheduled
    expect(recorded).toHaveLength(0); // no insert, no prune
  });

  it('skips registry probes / crawlers', () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logSample(c, { surface: 'mcp', tool: 'qsbs_check', clientName: 'glimind-probe', args: {} });
    expect(recorded).toHaveLength(0);
  });

  it('captures only the real rows from a mixed batch', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logSamples(c, [
      { surface: 'poe', clientName: 'poe', tool: 'qsbs_check', args: {} },
      { surface: 'mcp', clientName: 'smithery-probe', tool: 'nso_calculate', args: {} },
      { surface: 'rest', clientName: 'OptionsAhoy-smoke/1.0', tool: 'amt-iso', args: {} },
    ]);
    await Promise.all(c.waited);
    const inserts = recorded.filter((r) => r.sql.startsWith('INSERT INTO mcp_samples'));
    expect(inserts).toHaveLength(1); // only the real Poe row survives
    expect(inserts[0].bindings[3]).toBe('poe');
  });
});

// The capture is product feedback about HOW tools are called, and every public
// statement about the server says users' figures are not retained. Until
// 2026-10-06 it stored the full query and answer text: share counts, income,
// holdings, and Poe's whole conversation. These pin that no value, from any
// surface, reaches the insert.
describe('logSample stores the call shape, never a value', () => {
  const FIGURES = [50000, 412345, 98.76, '2021-03-15', 'NVDA', 'CA', 'my salary is 412345'];

  async function insertFor(fields: Parameters<typeof logSample>[1]) {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logSample(c, fields);
    await Promise.all(c.waited);
    return recorded.find((r) => r.sql.startsWith('INSERT INTO mcp_samples'))!.bindings;
  }

  function assertNoFigures(bindings: unknown[]) {
    const stored = JSON.stringify(bindings.slice(4, 6));
    for (const f of FIGURES) expect(stored, `stored ${String(f)}`).not.toContain(String(f));
  }

  it('keeps field names and value types from structured arguments', async () => {
    const b = await insertFor({
      surface: 'mcp',
      tool: 'equity_funding_plan',
      args: {
        targetAmount: 412345,
        stateCode: 'CA',
        stacks: [{ ticker: 'NVDA', currentPrice: 98.76, lots: [{ shares: 50000, acquisitionDate: '2021-03-15' }] }],
      },
    });
    expect(JSON.parse(b[4] as string)).toEqual({
      stacks: {
        items: 1,
        of: {
          currentPrice: 'number',
          lots: { items: 1, of: { acquisitionDate: 'string', shares: 'number' } },
          ticker: 'string',
        },
      },
      stateCode: 'string',
      targetAmount: 'number',
    });
    assertNoFigures(b);
  });

  it('never stores an answer', async () => {
    const b = await insertFor({ surface: 'rest', tool: 'nso', args: { shares: 50000 } });
    expect(b[5]).toBeNull();
  });

  it('reduces free text (a Poe or A2A message) to a word count', async () => {
    const b = await insertFor({ surface: 'a2a', args: 'my salary is 412345 and I hold 50000 NVDA' });
    expect(b[4]).toBe('free text, 9 words');
    assertNoFigures(b);
  });

  it('shapes JSON text the same as the object it encodes', async () => {
    const b = await insertFor({ surface: 'a2a', args: JSON.stringify({ skill: 'qsbs', input: { shares: 50000 } }) });
    expect(JSON.parse(b[4] as string)).toEqual({ input: { shares: 'number' }, skill: 'string' });
    assertNoFigures(b);
  });

  it('counts, rather than copies, keys that are not argument names', async () => {
    const b = await insertFor({ surface: 'mcp', args: { shares: 1, 'my salary is 412345': 1, '50000 NVDA': 2 } });
    expect(JSON.parse(b[4] as string)).toEqual({ shares: 'number', '(other keys)': 2 });
    assertNoFigures(b);
  });

  it('stops descending at a fixed depth', async () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { salary: 412345 } } } } } } } };
    const b = await insertFor({ surface: 'mcp', args: deep });
    expect(b[4]).toBe('{"a":{"b":{"c":{"d":{"e":{"f":"object"}}}}}}');
    assertNoFigures(b);
  });
});

describe('daily ticker counts', () => {
  const UPSERT = 'INSERT INTO mcp_ticker_daily';

  it('folds each named ticker into one upsert per call row, keyed by day, tool and outcome', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logCalls(c, [
      { endpoint: 'mcp:tools/call', tool: 'protective_put_price', isError: false, tickers: [{ ticker: 'NVDA', outcome: 'ok' }] },
      { endpoint: 'mcp:tools/call', tool: 'amt_iso_optimize', isError: true, tickers: [{ ticker: 'XYZQ', outcome: 'error' }] },
    ]);
    await Promise.all(c.waited);
    const ups = recorded.filter((r) => r.sql.startsWith(UPSERT));
    expect(ups.map((r) => r.bindings.slice(1))).toEqual([
      ['NVDA', 'protective_put_price', 'ok'],
      ['XYZQ', 'amt_iso_optimize', 'error'],
    ]);
    expect(ups[0].sql).toContain('ON CONFLICT(day, ticker, tool, outcome) DO UPDATE SET n = n + 1');
    expect(ups[0].bindings[0]).toBe(new Date().toISOString().slice(0, 10));
  });

  it('writes them in their own batch, so a missing table cannot cost the call log', async () => {
    const { db } = mockDb();
    const batch = vi.fn(async (stmts: D1PreparedStatement[]) => {
      for (const s of stmts) await s.run();
    });
    const c = ctx({ db: { ...db, batch } });
    logCalls(c, [
      { endpoint: 'mcp:tools/call', tool: 'nso_calculate', isError: false, tickers: [{ ticker: 'AAPL', outcome: 'ok' }] },
      { endpoint: 'mcp:tools/list', isError: false },
    ]);
    await Promise.all(c.waited);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[0][0]).toHaveLength(2); // the two call rows
    expect(batch.mock.calls[1][0]).toHaveLength(1); // the one ticker upsert
  });

  it('leaves our own monitors and scanners out', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db, ua: 'OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)' });
    logCalls(c, [{ endpoint: 'mcp:tools/call', tool: 'nso_calculate', isError: false, tickers: [{ ticker: 'NVDA', outcome: 'ok' }] }]);
    await Promise.all(c.waited);
    expect(recorded.filter((r) => r.sql.startsWith(UPSERT))).toHaveLength(0);
    expect(recorded.filter((r) => r.sql.startsWith('INSERT INTO mcp_calls'))).toHaveLength(1);
  });
});
