// AlphaLatitude Inc. © 2026
//
// Read layer for /admin/mcp-stats, backed by the mcp_dim_daily rollups
// (migration 0006).
//
// Why: the admin dashboard ran eleven windowed GROUP BYs straight at
// mcp_calls, ~200k rows each because date() grouping and endpoint LIKE
// predicates defeat the ts index. One page load cost ~2M rows_read - half
// the D1 free daily budget - and admin traffic alone pushed the account to
// 79% of the cap the day after the public surfaces were fixed.
//
// Shape of the fix, mirroring _lib/statsRollup: fold new calls into daily
// buckets ONCE, then answer every panel from the buckets. The difference is
// where the folding happens. These dimensions are read by exactly one
// consumer - a private dashboard opened a few times a day - so folding runs
// on admin page load against its OWN cursor (dim_snapshot.last_id), not on
// the public refresh path. The public endpoints therefore pay nothing for
// dimensions they never read, and an admin load pays for a day of new rows
// (~thousands) instead of the whole table.
//
// Window semantics change slightly and on purpose: `since` is snapped to a
// UTC day boundary, because a daily bucket cannot answer "the last 30 days
// to the millisecond". The dashboard's charts were already day-grained.

import type { D1Database, D1PreparedStatement } from './stats';

// Parallel admin loads must not both fold: a second fold reading the same
// rows would double the counts. The CAS below elects one; the other reads
// buckets at most this stale, which is nothing for a dashboard.
export const DIM_REFRESH_MS = 30_000;

interface DimCursor {
  last_id: number;
  computed_at: number;
}

// Each dimension is one aggregate over the newly-arrived rows, bounded on
// BOTH sides: `?1` is the cursor, `?2` the high-water mark being claimed.
// Without the ceiling, a call logged mid-fold would be counted here but not
// reflected in last_id, and would fold a second time on the next pass.
// Column order is fixed: day, k1..k4, n, errors.
interface DimSpec {
  dim: string;
  sql: string;
}

const DAY_EXPR = "date(ts / 1000, 'unixepoch')";

const DIMS: DimSpec[] = [
  {
    dim: 'endpoint',
    sql: `SELECT ${DAY_EXPR} AS day, COALESCE(endpoint, '') AS k1, '' AS k2, '' AS k3, '' AS k4,
                 COUNT(*) AS n, COALESCE(SUM(is_error), 0) AS errors
            FROM mcp_calls WHERE id > ?1 AND id <= ?2 GROUP BY day, k1`,
  },
  {
    dim: 'tool',
    sql: `SELECT ${DAY_EXPR} AS day, tool AS k1, '' AS k2, '' AS k3, '' AS k4,
                 COUNT(*) AS n, COALESCE(SUM(is_error), 0) AS errors
            FROM mcp_calls WHERE id > ?1 AND id <= ?2 AND tool IS NOT NULL GROUP BY day, k1`,
  },
  {
    dim: 'error',
    sql: `SELECT ${DAY_EXPR} AS day, COALESCE(endpoint, '') AS k1, COALESCE(tool, '') AS k2,
                 COALESCE(error_msg, '') AS k3, '' AS k4, COUNT(*) AS n, COUNT(*) AS errors
            FROM mcp_calls WHERE id > ?1 AND id <= ?2 AND is_error = 1 GROUP BY day, k1, k2, k3`,
  },
  {
    dim: 'errfield',
    sql: `SELECT ${DAY_EXPR} AS day, COALESCE(error_msg, '') AS k1, COALESCE(endpoint, '') AS k2,
                 COALESCE(client_name, ua, '') AS k3, '' AS k4, COUNT(*) AS n, COUNT(*) AS errors
            FROM mcp_calls
           WHERE id > ?1 AND id <= ?2 AND is_error = 1
             AND (endpoint = 'mcp:tools/call' OR endpoint LIKE 'rest:%')
           GROUP BY day, k1, k2, k3`,
  },
  {
    dim: 'client',
    sql: `SELECT ${DAY_EXPR} AS day, COALESCE(client_name, '') AS k1, COALESCE(endpoint, '') AS k2,
                 '' AS k3, '' AS k4, COUNT(*) AS n, COALESCE(SUM(is_error), 0) AS errors
            FROM mcp_calls
           WHERE id > ?1 AND id <= ?2 AND (endpoint = 'mcp:initialize' OR endpoint LIKE 'poe:%')
           GROUP BY day, k1, k2`,
  },
  {
    dim: 'country',
    sql: `SELECT ${DAY_EXPR} AS day, COALESCE(country, '') AS k1, '' AS k2, '' AS k3, '' AS k4,
                 COUNT(*) AS n, COALESCE(SUM(is_error), 0) AS errors
            FROM mcp_calls WHERE id > ?1 AND id <= ?2 GROUP BY day, k1`,
  },
  {
    dim: 'restnet',
    sql: `SELECT ${DAY_EXPR} AS day, COALESCE(as_org, '(unknown)') AS k1, COALESCE(city, '') AS k2,
                 COALESCE(region, '') AS k3, COALESCE(country, '') AS k4,
                 COUNT(*) AS n, COALESCE(SUM(is_error), 0) AS errors
            FROM mcp_calls WHERE id > ?1 AND id <= ?2 AND endpoint LIKE 'rest:%'
           GROUP BY day, k1, k2, k3, k4`,
  },
];

interface FoldRow {
  day: string;
  k1: string | null;
  k2: string;
  k3: string;
  k4: string;
  n: number;
  errors: number;
}

const SQL_CURSOR = 'SELECT last_id, computed_at FROM dim_snapshot WHERE id = 1';
const SQL_CLAIM = 'UPDATE dim_snapshot SET computed_at = ? WHERE id = 1 AND computed_at = ?';
const SQL_MAX_ID = 'SELECT COALESCE(MAX(id), 0) AS max_id FROM mcp_calls WHERE id > ?';
const SQL_UPSERT = `INSERT INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(dim, day, k1, k2, k3, k4) DO UPDATE SET n = n + excluded.n, errors = errors + excluded.errors`;
const SQL_ADVANCE = 'UPDATE dim_snapshot SET last_id = ? WHERE id = 1';

// Folds calls logged since the last fold into the daily buckets. Returns
// silently when another loader holds the claim, when there is nothing new,
// or when migration 0006 has not been applied - a dashboard must not 500
// because its rollups are cold, and it must never fall back to the scans
// this module exists to eliminate.
export async function ensureDimsFresh(db: D1Database, now: number): Promise<void> {
  const cur = (await db.prepare(SQL_CURSOR).all<DimCursor>()).results[0];
  if (!cur) return; // not migrated: reads below return empty panels
  if (now - cur.computed_at < DIM_REFRESH_MS) return;

  const claim = (await db.prepare(SQL_CLAIM).bind(now, cur.computed_at).run()) as
    | { meta?: { changes?: number } }
    | undefined;
  if ((claim?.meta?.changes ?? 1) !== 1) return; // another loader is folding

  // The high-water mark is read in the same pass as the aggregates and
  // committed with them, so last_id can never outrun what was folded: a
  // failure here leaves the cursor put and the same rows fold in next time.
  const maxRes = await db.prepare(SQL_MAX_ID).bind(cur.last_id).all<{ max_id: number }>();
  const maxId = maxRes.results[0]?.max_id ?? 0;
  if (maxId <= cur.last_id) return;

  const aggregates = await Promise.all(
    DIMS.map(async (d) => ({
      dim: d.dim,
      rows: (await db.prepare(d.sql).bind(cur.last_id, maxId).all<FoldRow>()).results,
    })),
  );

  const stmts: D1PreparedStatement[] = [];
  for (const { dim, rows } of aggregates) {
    for (const r of rows) {
      stmts.push(
        db
          .prepare(SQL_UPSERT)
          .bind(dim, r.day, r.k1 ?? '', r.k2 ?? '', r.k3 ?? '', r.k4 ?? '', r.n, r.errors),
      );
    }
  }
  stmts.push(db.prepare(SQL_ADVANCE).bind(maxId));

  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
}

// Day-granular floor for a ms-epoch window start.
export function sinceDay(sinceMs: number): string {
  return new Date(sinceMs).toISOString().slice(0, 10);
}

async function rows<T>(db: D1Database, sql: string, binds: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...binds).all<T>();
  return res.results;
}

const emptyToNull = (s: string): string | null => (s === '' ? null : s);

export async function readEndpoints(
  db: D1Database,
  day: string,
): Promise<{ endpoint: string; n: number; errors: number }[]> {
  return rows(
    db,
    `SELECT k1 AS endpoint, SUM(n) AS n, SUM(errors) AS errors FROM mcp_dim_daily
      WHERE dim = 'endpoint' AND day >= ? GROUP BY k1 ORDER BY n DESC`,
    [day],
  );
}

// Daily totals ride on the endpoint dimension: every call carries an
// endpoint, so summing that dimension per day is the same number the old
// unfiltered COUNT produced, without a second set of buckets to keep.
export async function readDailyTotals(db: D1Database, day: string): Promise<{ day: string; n: number }[]> {
  return rows(
    db,
    `SELECT day, SUM(n) AS n FROM mcp_dim_daily WHERE dim = 'endpoint' AND day >= ?
      GROUP BY day ORDER BY day DESC`,
    [day],
  );
}

// Successful calls only, per surface: n - errors is the is_error = 0 count
// the old queries computed with a WHERE clause.
export async function readDailyRest(db: D1Database, day: string): Promise<{ day: string; n: number }[]> {
  return rows(
    db,
    `SELECT day, SUM(n - errors) AS n FROM mcp_dim_daily
      WHERE dim = 'endpoint' AND day >= ? AND k1 LIKE 'rest:%'
      GROUP BY day HAVING SUM(n - errors) > 0 ORDER BY day DESC`,
    [day],
  );
}

export async function readDailyMcp(db: D1Database, day: string): Promise<{ day: string; n: number }[]> {
  return rows(
    db,
    `SELECT day, SUM(n - errors) AS n FROM mcp_dim_daily
      WHERE dim = 'endpoint' AND day >= ? AND k1 = 'mcp:tools/call'
      GROUP BY day HAVING SUM(n - errors) > 0 ORDER BY day DESC`,
    [day],
  );
}

export async function readTools(
  db: D1Database,
  day: string,
): Promise<{ tool: string; n: number; errors: number }[]> {
  return rows(
    db,
    `SELECT k1 AS tool, SUM(n) AS n, SUM(errors) AS errors FROM mcp_dim_daily
      WHERE dim = 'tool' AND day >= ? GROUP BY k1 ORDER BY n DESC`,
    [day],
  );
}

export async function readErrors(
  db: D1Database,
  day: string,
): Promise<{ endpoint: string; tool: string | null; error_msg: string; n: number }[]> {
  const r = await rows<{ k1: string; k2: string; k3: string; n: number }>(
    db,
    `SELECT k1, k2, k3, SUM(n) AS n FROM mcp_dim_daily WHERE dim = 'error' AND day >= ?
      GROUP BY k1, k2, k3 ORDER BY n DESC LIMIT 25`,
    [day],
  );
  return r.map((x) => ({ endpoint: x.k1, tool: emptyToNull(x.k2), error_msg: x.k3, n: x.n }));
}

export async function readEndpointErrors(
  db: D1Database,
  endpoint: string,
  day: string,
): Promise<{ error_msg: string; n: number }[]> {
  const r = await rows<{ k3: string; n: number }>(
    db,
    `SELECT k3, SUM(n) AS n FROM mcp_dim_daily WHERE dim = 'error' AND k1 = ? AND day >= ?
      GROUP BY k3 ORDER BY n DESC LIMIT 25`,
    [endpoint, day],
  );
  return r.map((x) => ({ error_msg: x.k3, n: x.n }));
}

export async function readErrFields(
  db: D1Database,
  day: string,
): Promise<{ error_msg: string; endpoint: string; client: string; n: number }[]> {
  const r = await rows<{ k1: string; k2: string; k3: string; n: number }>(
    db,
    `SELECT k1, k2, k3, SUM(n) AS n FROM mcp_dim_daily WHERE dim = 'errfield' AND day >= ?
      GROUP BY k1, k2, k3`,
    [day],
  );
  return r.map((x) => ({ error_msg: x.k1, endpoint: x.k2, client: x.k3, n: x.n }));
}

// Named clients only (handshakes carrying a client_name, plus Poe), matching
// the old WHERE client_name IS NOT NULL.
export async function readClients(
  db: D1Database,
  day: string,
): Promise<{ client_name: string; n: number }[]> {
  return rows(
    db,
    `SELECT k1 AS client_name, SUM(n) AS n FROM mcp_dim_daily
      WHERE dim = 'client' AND day >= ? AND k1 != ''
        AND (k2 = 'mcp:initialize' OR k2 LIKE 'poe:%')
      GROUP BY k1 ORDER BY n DESC`,
    [day],
  );
}

// Every initialize, named or not - the unnamed bucket is the probe swarm and
// the funnel needs it, so '' maps back to the null the old query returned.
export async function readInitClients(
  db: D1Database,
  day: string,
): Promise<{ client_name: string | null; n: number }[]> {
  const r = await rows<{ k1: string; n: number }>(
    db,
    `SELECT k1, SUM(n) AS n FROM mcp_dim_daily
      WHERE dim = 'client' AND day >= ? AND k2 = 'mcp:initialize' GROUP BY k1`,
    [day],
  );
  return r.map((x) => ({ client_name: emptyToNull(x.k1), n: x.n }));
}

export async function readCountries(
  db: D1Database,
  day: string,
): Promise<{ country: string | null; n: number }[]> {
  const r = await rows<{ k1: string; n: number }>(
    db,
    `SELECT k1, SUM(n) AS n FROM mcp_dim_daily WHERE dim = 'country' AND day >= ?
      GROUP BY k1 ORDER BY n DESC LIMIT 20`,
    [day],
  );
  return r.map((x) => ({ country: emptyToNull(x.k1), n: x.n }));
}

export async function readRestNet(
  db: D1Database,
  day: string,
): Promise<{ as_org: string; city: string; region: string; country: string; n: number }[]> {
  return rows(
    db,
    `SELECT k1 AS as_org, k2 AS city, k3 AS region, k4 AS country, SUM(n) AS n FROM mcp_dim_daily
      WHERE dim = 'restnet' AND day >= ? GROUP BY k1, k2, k3, k4 ORDER BY n DESC LIMIT 40`,
    [day],
  );
}
