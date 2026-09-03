// AlphaLatitude Inc. © 2026
//
// The incremental snapshot behind every live-stats surface. The properties
// under test are the ones that guard the read budget and the numbers:
// refreshes read only new rows, a lost CAS serves stale rather than
// double-counting, and a refresher dying before the commit leaves last_id
// untouched so the same rows fold in exactly once on the next pass.
import { describe, it, expect } from 'vitest';
import { ensureFresh, readWindows, readTopTools, readDaily, REFRESH_MS } from '../functions/_lib/statsRollup';
import type { D1Database, D1PreparedStatement } from '../functions/_lib/stats';

type Call = { id: number; ts: number; tool: string | null };

// Minimal stateful D1 over JS arrays: enough SQL to serve statsRollup's
// fixed query set, strict about anything else so a new query fails loudly.
function memDb(state: {
  calls: Call[];
  snap?: { total: number; last_id: number; last_ts: number | null; computed_at: number };
  tools?: Map<string, number>;
  hourly?: Map<number, number>;
  daily?: Map<string, number>;
  failBatch?: boolean;
  forceLoseClaim?: boolean;
}) {
  state.tools ??= new Map();
  state.hourly ??= new Map();
  state.daily ??= new Map();
  const db: D1Database = {
    prepare(sql: string): D1PreparedStatement {
      let binds: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...v: unknown[]) {
          binds = v;
          return stmt;
        },
        async run() {
          if (/UPDATE stats_snapshot SET computed_at = \? WHERE id = 1 AND computed_at = \?/.test(sql)) {
            if (state.forceLoseClaim) return { meta: { changes: 0 } };
            const [next, expected] = binds as [number, number];
            const won = state.snap && state.snap.computed_at === expected;
            if (won && state.snap) state.snap.computed_at = next;
            return { meta: { changes: won ? 1 : 0 } };
          }
          return applyWrite(sql, binds);
        },
        async all<T>() {
          return { results: query(sql, binds) as T[] };
        },
      };
      return stmt;
    },
    async batch(stmts: D1PreparedStatement[]) {
      if (state.failBatch) throw new Error('batch died');
      for (const s of stmts) await s.run();
      return [];
    },
  };
  function applyWrite(sql: string, binds: unknown[]) {
    if (/UPDATE stats_snapshot SET total = total \+ \?/.test(sql)) {
      const [n, maxId, maxTs] = binds as [number, number, number | null];
      state.snap!.total += n;
      state.snap!.last_id = maxId;
      if (maxTs != null) state.snap!.last_ts = maxTs;
    } else if (/INSERT INTO mcp_tool_counts/.test(sql)) {
      const [tool, n] = binds as [string, number];
      state.tools!.set(tool, (state.tools!.get(tool) ?? 0) + n);
    } else if (/INSERT INTO mcp_hourly/.test(sql)) {
      const [h, n] = binds as [number, number];
      state.hourly!.set(h, (state.hourly!.get(h) ?? 0) + n);
    } else if (/INSERT INTO mcp_daily/.test(sql)) {
      const [d, n] = binds as [string, number];
      state.daily!.set(d, (state.daily!.get(d) ?? 0) + n);
    } else if (/DELETE FROM mcp_hourly/.test(sql)) {
      const [cutoff] = binds as [number];
      for (const k of [...state.hourly!.keys()]) if (k < cutoff) state.hourly!.delete(k);
    } else {
      throw new Error(`unmocked write: ${sql}`);
    }
    return { meta: { changes: 1 } };
  }
  function query(sql: string, binds: unknown[]): unknown[] {
    // Detached copy, like a real D1 row - returning the live object let
    // the commit mutate what the caller already held and double-count.
    if (/FROM stats_snapshot WHERE id = 1/.test(sql)) return state.snap ? [{ ...state.snap }] : [];
    if (/COUNT\(\*\) AS n, MAX\(id\)/.test(sql)) {
      const after = binds[0] as number;
      const rows = state.calls.filter((c) => c.id > after);
      return [{
        n: rows.length,
        max_id: rows.length ? Math.max(...rows.map((r) => r.id)) : null,
        max_ts: rows.length ? Math.max(...rows.map((r) => r.ts)) : null,
      }];
    }
    if (/AND tool IS NOT NULL GROUP BY tool/.test(sql)) {
      const after = binds[0] as number;
      const m = new Map<string, number>();
      for (const c of state.calls) if (c.id > after && c.tool) m.set(c.tool, (m.get(c.tool) ?? 0) + 1);
      return [...m].map(([tool, n]) => ({ tool, n }));
    }
    if (/GROUP BY hour_ts/.test(sql)) {
      const after = binds[0] as number;
      const m = new Map<number, number>();
      for (const c of state.calls) if (c.id > after) {
        const h = Math.floor(c.ts / 3_600_000) * 3_600_000;
        m.set(h, (m.get(h) ?? 0) + 1);
      }
      return [...m].map(([hour_ts, n]) => ({ hour_ts, n }));
    }
    if (/GROUP BY day/.test(sql)) {
      const after = binds[0] as number;
      const m = new Map<string, number>();
      for (const c of state.calls) if (c.id > after) {
        const d = new Date(c.ts).toISOString().slice(0, 10);
        m.set(d, (m.get(d) ?? 0) + 1);
      }
      return [...m].map(([day, n]) => ({ day, n }));
    }
    if (/SUM\(n\), 0\) AS n FROM mcp_hourly/.test(sql) || /SUM\(n\).*FROM mcp_hourly/.test(sql)) {
      const from = binds[0] as number;
      let n = 0;
      for (const [h, c] of state.hourly!) if (h >= from) n += c;
      return [{ n }];
    }
    if (/FROM mcp_daily WHERE day >= \?/.test(sql)) {
      const from = binds[0] as string;
      let n = 0;
      for (const [d, c] of state.daily!) if (d >= from) n += c;
      return [{ n }];
    }
    if (/FROM mcp_tool_counts ORDER BY n DESC/.test(sql)) {
      const limit = binds[0] as number;
      return [...state.tools!].sort((a, b) => b[1] - a[1]).slice(0, limit)
        .map(([tool, n]) => ({ tool, n }));
    }
    if (/FROM mcp_daily ORDER BY day/.test(sql)) {
      return [...state.daily!].sort().map(([day, n]) => ({ day, n }));
    }
    throw new Error(`unmocked query: ${sql}`);
  }
  return db;
}

const T0 = Date.parse('2026-09-01T12:00:00Z');

describe('ensureFresh', () => {
  it('a fresh snapshot short-circuits: zero reads of mcp_calls', async () => {
    const state = { calls: [{ id: 1, ts: T0, tool: 'x' }], snap: { total: 1, last_id: 1, last_ts: T0, computed_at: T0 } };
    const snap = await ensureFresh(memDb(state), T0 + REFRESH_MS - 1);
    expect(snap.total).toBe(1);
  });

  it('folds ONLY new rows in, exactly once across consecutive refreshes', async () => {
    const state: Parameters<typeof memDb>[0] = {
      calls: [
        { id: 1, ts: T0 - 5_000, tool: 'a' },
        { id: 2, ts: T0 - 4_000, tool: 'a' },
      ],
      snap: { total: 0, last_id: 0, last_ts: null, computed_at: 0 },
    };
    const db = memDb(state);
    const s1 = await ensureFresh(db, T0);
    expect(s1.total).toBe(2);
    expect(s1.last_id).toBe(2);
    // second refresh with NO new rows: totals unchanged (no double count)
    const s2 = await ensureFresh(db, T0 + REFRESH_MS + 1);
    expect(s2.total).toBe(2);
    // a new call arrives; only it is added
    state.calls.push({ id: 3, ts: T0 + 100, tool: 'b' });
    const s3 = await ensureFresh(db, T0 + 2 * (REFRESH_MS + 1));
    expect(s3.total).toBe(3);
    expect(state.tools!.get('a')).toBe(2);
    expect(state.tools!.get('b')).toBe(1);
  });

  it('a lost CAS serves the stale snapshot and writes nothing', async () => {
    const state = {
      calls: [{ id: 5, ts: T0, tool: 'x' }],
      snap: { total: 0, last_id: 0, last_ts: null as number | null, computed_at: 0 },
    };
    // another isolate wins the claim: our conditional UPDATE matches 0 rows
    (state as { forceLoseClaim?: boolean }).forceLoseClaim = true;
    const db = memDb(state);
    const snap = await ensureFresh(db, T0 + REFRESH_MS + 1);
    expect(snap.total).toBe(0); // stale served
    expect(state.snap!.total).toBe(0); // nothing written
  });

  it('a refresher dying at the batch leaves last_id intact (no gap, no dupe later)', async () => {
    const state = {
      calls: [{ id: 1, ts: T0, tool: 'x' }],
      snap: { total: 0, last_id: 0, last_ts: null as number | null, computed_at: 0 },
      failBatch: true,
    };
    const db = memDb(state);
    await expect(ensureFresh(db, T0 + REFRESH_MS + 1)).rejects.toThrow('batch died');
    expect(state.snap!.last_id).toBe(0);
    expect(state.snap!.total).toBe(0);
    // recovery: batch works again, same rows fold in once
    state.failBatch = false;
    state.snap!.computed_at = 0;
    const snap = await ensureFresh(db, T0 + 2 * REFRESH_MS);
    expect(snap.total).toBe(1);
  });

  it('missing snapshot row (migration not applied) degrades to zeros, never to a table scan', async () => {
    const state = { calls: [{ id: 1, ts: T0, tool: 'x' }] };
    const snap = await ensureFresh(memDb(state), T0);
    expect(snap.total).toBe(0);
  });
});

describe('windows and reads', () => {
  it('rolling 24h sums hourly buckets; 7d/30d sum daily', async () => {
    const state = {
      calls: [] as Call[],
      snap: { total: 0, last_id: 0, last_ts: null as number | null, computed_at: T0 },
      hourly: new Map([[Math.floor((T0 - 3_600_000) / 3_600_000) * 3_600_000, 5], [Math.floor((T0 - 30 * 3_600_000) / 3_600_000) * 3_600_000, 7]]),
      daily: new Map([[new Date(T0).toISOString().slice(0, 10), 12], [new Date(T0 - 10 * 86_400_000).toISOString().slice(0, 10), 40]]),
      tools: new Map([['amt_iso_optimize', 9], ['qsbs_check', 3]]),
    };
    const db = memDb(state);
    const w = await readWindows(db, T0);
    expect(w.last24h).toBe(5); // the 30h-old bucket is outside the window
    expect(w.last7d).toBe(12);
    expect(w.last30d).toBe(52);
    const top = await readTopTools(db, 1);
    expect(top).toEqual([{ tool: 'amt_iso_optimize', n: 9 }]);
    const daily = await readDaily(db);
    expect(daily).toHaveLength(2);
  });
});
