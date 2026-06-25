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
    expect(() => logSample(c, { surface: 'poe', query: 'q', answer: 'a' })).not.toThrow();
    expect(c.waited).toHaveLength(0);
  });

  it('writes one mcp_samples insert + a 7-day prune, truncates, hands promise to waitUntil', async () => {
    const { db, recorded } = mockDb();
    const c = ctx({ db });
    logSample(c, {
      surface: 'poe',
      tool: 'qsbs_check',
      clientName: 'poe',
      query: 'Q'.repeat(5000),
      answer: 'A'.repeat(9000),
    });
    expect(c.waited).toHaveLength(1);
    await Promise.all(c.waited);

    const inserts = recorded.filter((r) => r.sql.startsWith('INSERT INTO mcp_samples'));
    const prunes = recorded.filter((r) => r.sql.startsWith('DELETE FROM mcp_samples'));
    expect(inserts).toHaveLength(1);
    expect(prunes).toHaveLength(1);

    const b = inserts[0].bindings; // ts, surface, tool, client_name, query, answer
    expect(b[1]).toBe('poe');
    expect(b[2]).toBe('qsbs_check');
    expect((b[4] as string).length).toBe(4000); // query truncated
    expect((b[5] as string).length).toBe(8000); // answer truncated

    const cutoff = prunes[0].bindings[0] as number;
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(cutoff).toBeGreaterThan(Date.now() - 8 * 86_400_000); // ~7 days back
  });
});
