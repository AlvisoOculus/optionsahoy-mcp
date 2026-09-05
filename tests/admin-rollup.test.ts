// AlphaLatitude Inc. © 2026
//
// The dimensional rollups behind /admin/mcp-stats. These tests guard the two
// properties that keep the D1 read budget intact and the numbers honest:
// folding is exactly-once (no double counting, no lost rows), and NOTHING in
// this path ever scans mcp_calls unbounded - that scan is the bug it replaced,
// so the fake D1 below throws on any mcp_calls read that is not id-bounded.
import { describe, it, expect } from 'vitest';
import {
  ensureDimsFresh,
  sinceDay,
  readEndpoints,
  readDailyTotals,
  readDailyRest,
  readDailyMcp,
  readErrors,
  readInitClients,
  readCountries,
  DIM_REFRESH_MS,
} from '../functions/_lib/adminRollup';
import type { D1Database, D1PreparedStatement } from '../functions/_lib/stats';

type Call = {
  id: number;
  ts: number;
  endpoint: string;
  tool?: string | null;
  is_error?: number;
  error_msg?: string | null;
  client_name?: string | null;
  ua?: string | null;
  country?: string | null;
  as_org?: string | null;
  city?: string | null;
  region?: string | null;
};
type Bucket = { dim: string; day: string; k1: string; k2: string; k3: string; k4: string; n: number; errors: number };

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const bucketKey = (b: Omit<Bucket, 'n' | 'errors'>) => [b.dim, b.day, b.k1, b.k2, b.k3, b.k4].join('|');

interface State {
  calls: Call[];
  cursor?: { last_id: number; computed_at: number };
  buckets: Map<string, Bucket>;
  failBatch?: boolean;
  forceLoseClaim?: boolean;
  onWindowClaimed?: () => void;
  scans: number;
}

function newState(over: Partial<State> & { calls: Call[] }): State {
  return { buckets: new Map(), scans: 0, ...over };
}

// Stateful in-memory D1 understanding exactly the queries this module issues.
function memDb(state: State): D1Database {
  const db: D1Database = {
    prepare(sql: string): D1PreparedStatement {
      let binds: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...v: unknown[]) {
          binds = v;
          return stmt;
        },
        async run() {
          return write(sql, binds);
        },
        async all<T>() {
          return { results: read(sql, binds) as T[] };
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

  function write(sql: string, binds: unknown[]) {
    if (/UPDATE dim_snapshot SET computed_at/.test(sql)) {
      if (state.forceLoseClaim) return { meta: { changes: 0 } };
      const [next, expected] = binds as [number, number];
      const won = !!state.cursor && state.cursor.computed_at === expected;
      if (won && state.cursor) state.cursor.computed_at = next;
      return { meta: { changes: won ? 1 : 0 } };
    }
    if (/UPDATE dim_snapshot SET last_id/.test(sql)) {
      state.cursor!.last_id = binds[0] as number;
      return { meta: { changes: 1 } };
    }
    if (/INSERT INTO mcp_dim_daily/.test(sql)) {
      const [dim, day, k1, k2, k3, k4, n, errors] = binds as [string, string, string, string, string, string, number, number];
      const k = bucketKey({ dim, day, k1, k2, k3, k4 });
      const prev = state.buckets.get(k);
      if (prev) {
        prev.n += n;
        prev.errors += errors;
      } else {
        state.buckets.set(k, { dim, day, k1, k2, k3, k4, n, errors });
      }
      return { meta: { changes: 1 } };
    }
    throw new Error(`unmocked write: ${sql}`);
  }

  // Every mcp_calls read MUST carry the cursor bound. An unbounded one is the
  // production bug this module removed, so it fails the suite here.
  function newCalls(sql: string, binds: unknown[]): Call[] {
    if (!/WHERE id > \?/.test(sql)) throw new Error(`UNBOUNDED mcp_calls read: ${sql}`);
    state.scans += 1;
    const after = binds[0] as number;
    // A missing ceiling means "no ceiling", so unbounded code is exercised for
    // what it actually does rather than failing on a bind count.
    const upto = (binds[1] as number | undefined) ?? Number.POSITIVE_INFINITY;
    return state.calls.filter((c) => c.id > after && c.id <= upto);
  }

  function fold(
    rows: Call[],
    keyFn: (c: Call) => [string, string, string, string],
    errorsAreAll = false,
  ): Array<{ day: string; k1: string; k2: string; k3: string; k4: string; n: number; errors: number }> {
    const m = new Map<string, { day: string; k1: string; k2: string; k3: string; k4: string; n: number; errors: number }>();
    for (const c of rows) {
      const [k1, k2, k3, k4] = keyFn(c);
      const day = dayOf(c.ts);
      const k = [day, k1, k2, k3, k4].join('|');
      const cur = m.get(k) ?? { day, k1, k2, k3, k4, n: 0, errors: 0 };
      cur.n += 1;
      cur.errors += errorsAreAll ? 1 : (c.is_error ?? 0);
      m.set(k, cur);
    }
    return [...m.values()];
  }

  function read(sql: string, binds: unknown[]): unknown[] {
    if (/FROM dim_snapshot WHERE id = 1/.test(sql)) return state.cursor ? [{ ...state.cursor }] : [];

    if (/AS max_id FROM mcp_calls/.test(sql)) {
      const rows = newCalls(sql, binds);
      const max = rows.length ? Math.max(...rows.map((r) => r.id)) : 0;
      state.onWindowClaimed?.(); // simulates a call landing mid-fold
      return [{ max_id: max }];
    }

    if (/FROM mcp_calls/.test(sql)) {
      const rows = newCalls(sql, binds);
      if (/tool IS NOT NULL/.test(sql)) {
        return fold(rows.filter((c) => c.tool), (c) => [c.tool as string, '', '', '']);
      }
      if (/mcp:tools\/call' OR endpoint LIKE 'rest:%/.test(sql)) {
        return fold(
          rows.filter((c) => c.is_error && (c.endpoint === 'mcp:tools/call' || c.endpoint.startsWith('rest:'))),
          (c) => [c.error_msg ?? '', c.endpoint, c.client_name ?? c.ua ?? '', ''],
          true,
        );
      }
      if (/is_error = 1/.test(sql)) {
        return fold(rows.filter((c) => c.is_error), (c) => [c.endpoint, c.tool ?? '', c.error_msg ?? '', ''], true);
      }
      if (/mcp:initialize' OR endpoint LIKE 'poe:%/.test(sql)) {
        return fold(
          rows.filter((c) => c.endpoint === 'mcp:initialize' || c.endpoint.startsWith('poe:')),
          (c) => [c.client_name ?? '', c.endpoint, '', ''],
        );
      }
      if (/as_org/.test(sql)) {
        return fold(rows.filter((c) => c.endpoint.startsWith('rest:')), (c) => [
          c.as_org ?? '(unknown)',
          c.city ?? '',
          c.region ?? '',
          c.country ?? '',
        ]);
      }
      if (/COALESCE\(country, ''\) AS k1/.test(sql)) return fold(rows, (c) => [c.country ?? '', '', '', '']);
      return fold(rows, (c) => [c.endpoint, '', '', '']); // endpoint dimension
    }

    if (/FROM mcp_dim_daily/.test(sql)) {
      const dim = /dim = '([a-z]+)'/.exec(sql)![1];
      const from = binds[binds.length - 1] as string;
      let rows = [...state.buckets.values()].filter((b) => b.dim === dim && b.day >= from);
      if (/k1 LIKE 'rest:%'/.test(sql)) rows = rows.filter((b) => b.k1.startsWith('rest:'));
      if (/k1 = 'mcp:tools\/call'/.test(sql)) rows = rows.filter((b) => b.k1 === 'mcp:tools/call');
      if (/k1 != ''/.test(sql)) rows = rows.filter((b) => b.k1 !== '');
      if (/k2 = 'mcp:initialize'/.test(sql) && !/k1 != ''/.test(sql)) rows = rows.filter((b) => b.k2 === 'mcp:initialize');
      if (/AND k1 = \?/.test(sql)) rows = rows.filter((b) => b.k1 === (binds[0] as string));

      const net = /SUM\(n - errors\)/.test(sql);
      const byDay = /GROUP BY day/.test(sql);
      const out = new Map<string, Record<string, unknown>>();
      for (const b of rows) {
        const gk = byDay ? b.day : [b.k1, b.k2, b.k3, b.k4].join('|');
        const cur =
          out.get(gk) ??
          (byDay
            ? { day: b.day, n: 0 }
            : {
                day: b.day,
                endpoint: b.k1,
                tool: b.k1,
                client_name: b.k1,
                as_org: b.k1,
                city: b.k2,
                region: b.k3,
                country: b.k4,
                k1: b.k1,
                k2: b.k2,
                k3: b.k3,
                k4: b.k4,
                n: 0,
                errors: 0,
              });
        cur.n = (cur.n as number) + (net ? b.n - b.errors : b.n);
        if (!byDay) cur.errors = (cur.errors as number) + b.errors;
        out.set(gk, cur);
      }
      let list = [...out.values()];
      if (net) list = list.filter((r) => (r.n as number) > 0);
      return list.sort((a, b) => (b.n as number) - (a.n as number));
    }
    throw new Error(`unmocked query: ${sql}`);
  }

  return db;
}

const T0 = Date.parse('2026-09-04T12:00:00Z');
const DAY_MS = 86_400_000;
const call = (over: Partial<Call> & { id: number }): Call => ({ ts: T0, endpoint: 'mcp:tools/call', ...over });

describe('ensureDimsFresh', () => {
  it('folds each call exactly once across repeated refreshes', async () => {
    const state = newState({
      calls: [
        call({ id: 1, tool: 'amt_iso_optimize' }),
        call({ id: 2, tool: 'amt_iso_optimize', is_error: 1, error_msg: 'field "shares" required' }),
        call({ id: 3, endpoint: 'rest:concentration' }),
      ],
      cursor: { last_id: 0, computed_at: 0 },
    });
    const db = memDb(state);
    const window = sinceDay(T0 - DAY_MS);

    await ensureDimsFresh(db, T0);
    expect(await readDailyTotals(db, window)).toEqual([{ day: dayOf(T0), n: 3 }]);

    // Nothing new: the counts must not move.
    await ensureDimsFresh(db, T0 + DIM_REFRESH_MS + 1);
    expect(await readDailyTotals(db, window)).toEqual([{ day: dayOf(T0), n: 3 }]);

    // One new call: only it is added.
    state.calls.push(call({ id: 4, endpoint: 'rest:concentration' }));
    await ensureDimsFresh(db, T0 + 2 * (DIM_REFRESH_MS + 1));
    expect(await readDailyTotals(db, window)).toEqual([{ day: dayOf(T0), n: 4 }]);
    expect(state.cursor!.last_id).toBe(4);
  });

  it('counts a call logged mid-fold once, not twice', async () => {
    const state = newState({
      calls: [call({ id: 1, endpoint: 'rest:amt' })],
      cursor: { last_id: 0, computed_at: 0 },
    });
    let injected = false;
    state.onWindowClaimed = () => {
      if (injected) return;
      injected = true;
      state.calls.push(call({ id: 2, endpoint: 'rest:amt' }));
    };
    const db = memDb(state);
    await ensureDimsFresh(db, T0);
    await ensureDimsFresh(db, T0 + 2 * DIM_REFRESH_MS);
    expect(state.calls).toHaveLength(2);
    expect(await readDailyTotals(db, sinceDay(T0 - DAY_MS))).toEqual([{ day: dayOf(T0), n: 2 }]);
  });

  it('serves without folding when another loader holds the claim', async () => {
    const state = newState({
      calls: [call({ id: 1 })],
      cursor: { last_id: 0, computed_at: 0 },
      forceLoseClaim: true,
    });
    const db = memDb(state);
    await ensureDimsFresh(db, T0 + DIM_REFRESH_MS + 1);
    expect(state.cursor!.last_id).toBe(0);
    expect(await readDailyTotals(db, sinceDay(T0 - DAY_MS))).toEqual([]);
  });

  it('leaves the cursor put when the commit fails, then folds once on retry', async () => {
    const state = newState({
      calls: [call({ id: 1 }), call({ id: 2 })],
      cursor: { last_id: 0, computed_at: 0 },
      failBatch: true,
    });
    const db = memDb(state);
    await expect(ensureDimsFresh(db, T0 + DIM_REFRESH_MS + 1)).rejects.toThrow('batch died');
    expect(state.cursor!.last_id).toBe(0);

    state.failBatch = false;
    state.cursor!.computed_at = 0;
    await ensureDimsFresh(db, T0 + 2 * DIM_REFRESH_MS);
    expect(await readDailyTotals(db, sinceDay(T0 - DAY_MS))).toEqual([{ day: dayOf(T0), n: 2 }]);
  });

  it('does not touch mcp_calls at all when migration 0006 is missing', async () => {
    const state = newState({ calls: [call({ id: 1 })] }); // no dim_snapshot row
    const db = memDb(state);
    await expect(ensureDimsFresh(db, T0)).resolves.toBeUndefined();
    expect(state.scans).toBe(0); // the whole point: never fall back to scanning
  });

  it('skips the fold entirely inside the refresh window', async () => {
    const state = newState({ calls: [call({ id: 1 })], cursor: { last_id: 0, computed_at: T0 } });
    const db = memDb(state);
    await ensureDimsFresh(db, T0 + DIM_REFRESH_MS - 1);
    expect(state.scans).toBe(0);
  });
});

describe('panel reads', () => {
  it('windows by day and derives per-surface success counts', async () => {
    const state = newState({
      calls: [
        call({ id: 1, ts: T0 - 5 * DAY_MS, endpoint: 'rest:amt' }),
        call({ id: 2, endpoint: 'rest:amt' }),
        call({ id: 3, endpoint: 'rest:amt', is_error: 1, error_msg: 'bad' }),
        call({ id: 4, endpoint: 'mcp:tools/call' }),
        call({ id: 5, endpoint: 'mcp:initialize', client_name: 'claude-code' }),
        call({ id: 6, endpoint: 'mcp:initialize', client_name: null }),
        call({ id: 7, country: 'US' }),
      ],
      cursor: { last_id: 0, computed_at: 0 },
    });
    const db = memDb(state);
    await ensureDimsFresh(db, T0);

    // A two-day window excludes the five-day-old call.
    const recent = sinceDay(T0 - 2 * DAY_MS);
    expect(await readDailyTotals(db, recent)).toEqual([{ day: dayOf(T0), n: 6 }]);

    // Successful calls per surface: three REST rows in-window, one errored.
    expect(await readDailyRest(db, recent)).toEqual([{ day: dayOf(T0), n: 1 }]);
    expect(await readDailyMcp(db, recent)).toEqual([{ day: dayOf(T0), n: 2 }]);

    const eps = await readEndpoints(db, recent);
    expect(eps.find((e) => e.endpoint === 'rest:amt')).toMatchObject({ endpoint: 'rest:amt', n: 2, errors: 1 });

    // The unnamed handshake bucket must come back as null, not '': the funnel's
    // probe classifier depends on telling an unnamed client from a named one.
    expect(await readInitClients(db, recent)).toEqual(
      expect.arrayContaining([
        { client_name: 'claude-code', n: 1 },
        { client_name: null, n: 1 },
      ]),
    );

    const errs = await readErrors(db, recent);
    expect(errs[0]).toMatchObject({ endpoint: 'rest:amt', error_msg: 'bad', tool: null });

    expect((await readCountries(db, recent)).find((c) => c.country === 'US')).toEqual({ country: 'US', n: 1 });
  });

  it('never re-reads mcp_calls once the buckets are folded', async () => {
    const state = newState({ calls: [call({ id: 1 })], cursor: { last_id: 0, computed_at: 0 } });
    const db = memDb(state);
    await ensureDimsFresh(db, T0);
    const afterFold = state.scans;
    await readEndpoints(db, sinceDay(T0));
    await readDailyTotals(db, sinceDay(T0));
    await readCountries(db, sinceDay(T0));
    expect(state.scans).toBe(afterFold);
  });
});
