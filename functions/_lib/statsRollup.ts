// AlphaLatitude Inc. © 2026
//
// Incremental stats rollup: the read path for every live-statistics
// surface (/api/v1/stats, /api/v1/badge, /mcp/usage).
//
// Why this exists: those endpoints used to COUNT/GROUP BY over all of
// mcp_calls on every cache miss, edge caching is per-colo, and scanners
// hit the public surface from everywhere - the combination blew through
// D1's free-tier 5M rows_read/day (account-wide read outage, 2026-09-01).
//
// The liveness requirement is real (Andrew: the MCP call statistics must
// remain live), so the fix is NOT a long cache. It is an incremental
// snapshot: refresh reads ONLY rows with id > last_id (primary-key
// bounded - a minute of new calls, usually zero to a handful) and folds
// them into four tiny rollup tables. Serving reads ~60 rollup rows total.
// Numbers stay 60-second fresh; the cost of freshness drops ~99.9%.
//
// Concurrency: many isolates can miss the cache at once. A CAS on
// stats_snapshot.computed_at elects one refresher; losers serve the
// snapshot as-is (at most REFRESH_MS stale). The data write commits
// total/last_id and the rollup upserts in ONE batch, so a refresher dying
// mid-way leaves last_id untouched and the next refresh re-reads the same
// new rows - no double counting, no gaps.

import type { D1Database } from './stats';

export const REFRESH_MS = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface Snapshot {
  total: number;
  last_id: number;
  last_ts: number | null;
  computed_at: number;
}

interface NewAgg {
  n: number;
  max_id: number | null;
  max_ts: number | null;
}
interface ToolRow {
  tool: string;
  n: number;
}
interface HourRow {
  hour_ts: number;
  n: number;
}
interface DayRow {
  day: string;
  n: number;
}

const SQL_SNAPSHOT = 'SELECT total, last_id, last_ts, computed_at FROM stats_snapshot WHERE id = 1';
// CAS claim: only the isolate that flips computed_at does the work.
const SQL_CLAIM =
  'UPDATE stats_snapshot SET computed_at = ? WHERE id = 1 AND computed_at = ?';
// Everything below is bounded by id > ? - the primary key, so D1 reads
// exactly the new rows, never the table.
const SQL_NEW_AGG =
  'SELECT COUNT(*) AS n, MAX(id) AS max_id, MAX(ts) AS max_ts FROM mcp_calls WHERE id > ?';
// Bounded on BOTH sides. The upper bound is the max_id the aggregate above
// just claimed: without it a call logged between the two reads would be
// counted in these dimensions but not in last_id, and would then fold in a
// second time on the next refresh - totals right, per-tool and per-day
// counters drifting upward forever.
const SQL_NEW_TOOLS =
  'SELECT tool, COUNT(*) AS n FROM mcp_calls WHERE id > ? AND id <= ? AND tool IS NOT NULL GROUP BY tool';
const SQL_NEW_HOURLY =
  'SELECT (ts / 3600000) * 3600000 AS hour_ts, COUNT(*) AS n FROM mcp_calls WHERE id > ? AND id <= ? GROUP BY hour_ts';
const SQL_NEW_DAILY =
  "SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM mcp_calls WHERE id > ? AND id <= ? GROUP BY day";
const SQL_COMMIT =
  'UPDATE stats_snapshot SET total = total + ?, last_id = ?, last_ts = COALESCE(?, last_ts) WHERE id = 1';
const SQL_UPSERT_TOOL =
  'INSERT INTO mcp_tool_counts (tool, n) VALUES (?, ?) ON CONFLICT(tool) DO UPDATE SET n = n + excluded.n';
const SQL_UPSERT_HOUR =
  'INSERT INTO mcp_hourly (hour_ts, n) VALUES (?, ?) ON CONFLICT(hour_ts) DO UPDATE SET n = n + excluded.n';
const SQL_UPSERT_DAY =
  'INSERT INTO mcp_daily (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = n + excluded.n';
// Rolling-24h needs 25 buckets; keep 48h so clock skew can't bite, and
// prune opportunistically (a write, costs nothing against the read tier).
const SQL_PRUNE_HOURLY = 'DELETE FROM mcp_hourly WHERE hour_ts < ?';

// Reads the snapshot and, when it is older than REFRESH_MS, folds in the
// rows that arrived since. Always returns a usable snapshot; a lost CAS
// or a refresh error degrades to "up to a minute stale", never to a miss.
export async function ensureFresh(db: D1Database, now: number): Promise<Snapshot> {
  const snapRes = await db.prepare(SQL_SNAPSHOT).all<Snapshot>();
  const snap = snapRes.results[0];
  if (!snap) {
    // Migration 0005 not applied yet. Fail soft with zeros rather than
    // recreating the old full-scan behavior as a "fallback" - that
    // fallback is exactly what melted the read budget.
    return { total: 0, last_id: 0, last_ts: null, computed_at: 0 };
  }
  if (now - snap.computed_at < REFRESH_MS) return snap;

  const claim = (await db.prepare(SQL_CLAIM).bind(now, snap.computed_at).run()) as
    | { meta?: { changes?: number } }
    | undefined;
  const won = (claim?.meta?.changes ?? 1) === 1; // mocks without meta: proceed
  if (!won) return snap;

  // Claim the window first, then aggregate strictly inside it. Serialized on
  // purpose: the dimension queries need the ceiling this one returns.
  const agg = await db.prepare(SQL_NEW_AGG).bind(snap.last_id).all<NewAgg>();
  const a = agg.results[0];
  if (!a || a.n === 0 || a.max_id == null) {
    return { ...snap, computed_at: now };
  }
  const [tools, hours, days] = await Promise.all([
    db.prepare(SQL_NEW_TOOLS).bind(snap.last_id, a.max_id).all<ToolRow>(),
    db.prepare(SQL_NEW_HOURLY).bind(snap.last_id, a.max_id).all<HourRow>(),
    db.prepare(SQL_NEW_DAILY).bind(snap.last_id, a.max_id).all<DayRow>(),
  ]);

  const stmts = [
    db.prepare(SQL_COMMIT).bind(a.n, a.max_id, a.max_ts),
    ...tools.results.map((t) => db.prepare(SQL_UPSERT_TOOL).bind(t.tool, t.n)),
    ...hours.results.map((h) => db.prepare(SQL_UPSERT_HOUR).bind(h.hour_ts, h.n)),
    ...days.results.map((d) => db.prepare(SQL_UPSERT_DAY).bind(d.day, d.n)),
    db.prepare(SQL_PRUNE_HOURLY).bind(now - 2 * DAY),
  ];
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();

  return {
    total: snap.total + a.n,
    last_id: a.max_id ?? snap.last_id,
    last_ts: a.max_ts ?? snap.last_ts,
    computed_at: now,
  };
}

// Rolling windows from the rollups. last24h is exact to the hour bucket:
// the sum of every bucket that overlaps the trailing 24 hours.
export async function readWindows(
  db: D1Database,
  now: number,
): Promise<{ last24h: number; last7d: number; last30d: number }> {
  const hourFloor = Math.floor((now - DAY) / HOUR) * HOUR;
  const day7 = new Date(now - 7 * DAY).toISOString().slice(0, 10);
  const day30 = new Date(now - 30 * DAY).toISOString().slice(0, 10);
  const [h, d7, d30] = await Promise.all([
    db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM mcp_hourly WHERE hour_ts >= ?')
      .bind(hourFloor)
      .all<{ n: number }>(),
    db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM mcp_daily WHERE day >= ?')
      .bind(day7)
      .all<{ n: number }>(),
    db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM mcp_daily WHERE day >= ?')
      .bind(day30)
      .all<{ n: number }>(),
  ]);
  return {
    last24h: h.results[0]?.n ?? 0,
    last7d: d7.results[0]?.n ?? 0,
    last30d: d30.results[0]?.n ?? 0,
  };
}

export async function readTopTools(
  db: D1Database,
  limit: number,
): Promise<Array<{ tool: string; n: number }>> {
  const res = await db
    .prepare('SELECT tool, n FROM mcp_tool_counts ORDER BY n DESC LIMIT ?')
    .bind(limit)
    .all<ToolRow>();
  return res.results;
}

export async function readDaily(db: D1Database): Promise<DayRow[]> {
  const res = await db.prepare('SELECT day, n FROM mcp_daily ORDER BY day').all<DayRow>();
  return res.results;
}
