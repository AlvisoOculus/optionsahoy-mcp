-- AlphaLatitude Inc. © 2026
--
-- Rollup tables so the live stats surface stops scanning mcp_calls.
-- Before this, /api/v1/stats + /api/v1/badge + /mcp/usage each ran
-- unbounded COUNT/GROUP BY over the whole call log per cache miss, and
-- edge caching is per-colo - the combination exceeded D1's free-tier
-- 5M rows_read/day on 2026-09-01 and took the account's reads down.
--
-- The snapshot advances incrementally: each refresh reads ONLY rows with
-- id > last_id (primary-key bounded), so serving cost is O(new rows +
-- ~60 rollup rows) instead of O(all rows) - and the numbers stay LIVE
-- (60s refresh) because reading five new rows every minute is free.
--
-- These rollups also make retention safe: mcp_calls rows older than the
-- retention window can be deleted without losing the all-history usage
-- curve or the lifetime total, which live here now.

CREATE TABLE IF NOT EXISTS stats_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total INTEGER NOT NULL DEFAULT 0,
  last_id INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER,
  computed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mcp_tool_counts (
  tool TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);

-- hour_ts = epoch ms truncated to the hour. Rolling 24h = sum of the
-- last 25 buckets; old buckets are pruned opportunistically on refresh.
CREATE TABLE IF NOT EXISTS mcp_hourly (
  hour_ts INTEGER PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);

-- day = 'YYYY-MM-DD' UTC. Powers last7d/last30d and the /mcp/usage
-- all-history curve. Never pruned: ~365 rows/year is nothing.
CREATE TABLE IF NOT EXISTS mcp_daily (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);

-- One-time seed from the existing log (a final full scan, run once at
-- apply time). INSERT OR IGNORE keeps re-applies harmless.
INSERT OR IGNORE INTO stats_snapshot (id, total, last_id, last_ts, computed_at)
  SELECT 1, COUNT(*), COALESCE(MAX(id), 0), MAX(ts), 0 FROM mcp_calls;
INSERT OR IGNORE INTO mcp_tool_counts (tool, n)
  SELECT tool, COUNT(*) FROM mcp_calls WHERE tool IS NOT NULL GROUP BY tool;
INSERT OR IGNORE INTO mcp_hourly (hour_ts, n)
  SELECT (ts / 3600000) * 3600000, COUNT(*) FROM mcp_calls
  WHERE ts >= (CAST(strftime('%s','now') AS INTEGER) * 1000) - 172800000
  GROUP BY (ts / 3600000) * 3600000;
INSERT OR IGNORE INTO mcp_daily (day, n)
  SELECT date(ts / 1000, 'unixepoch'), COUNT(*) FROM mcp_calls
  GROUP BY date(ts / 1000, 'unixepoch');
