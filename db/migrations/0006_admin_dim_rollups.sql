-- AlphaLatitude Inc. © 2026
--
-- Dimensional daily rollups for /admin/mcp-stats.
--
-- Migration 0005 took the PUBLIC surfaces off full-table scans; the admin
-- dashboard was left alone on the theory that it runs rarely. That was
-- wrong: it fires eleven windowed GROUP BYs per load, none of which can use
-- the ts index (date() grouping, endpoint LIKE predicates), so each load
-- read ~2M rows - two loads is half the free daily budget, and the account
-- hit 79% of the cap on admin traffic alone the day after 0005 shipped.
--
-- One generic table serves all eleven. Each row is a (dimension, day, up to
-- four key columns) bucket with a count and an error count; every admin
-- panel becomes a GROUP BY over the handful of rows in its window instead
-- of a scan over every call ever logged. Generic beats eleven bespoke
-- tables: new panels get a new `dim` value, not new DDL.
--
-- Key columns are NOT NULL with '' defaults rather than nullable, because
-- SQLite treats NULLs as distinct in a PRIMARY KEY - nullable keys would
-- silently accumulate duplicate buckets instead of accumulating counts.
-- The read layer maps '' back to null where the old queries returned null.

CREATE TABLE IF NOT EXISTS mcp_dim_daily (
  dim    TEXT NOT NULL,
  day    TEXT NOT NULL,
  k1     TEXT NOT NULL DEFAULT '',
  k2     TEXT NOT NULL DEFAULT '',
  k3     TEXT NOT NULL DEFAULT '',
  k4     TEXT NOT NULL DEFAULT '',
  n      INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dim, day, k1, k2, k3, k4)
);

-- Own cursor, deliberately separate from stats_snapshot's: these rollups
-- are refreshed by admin page loads (rare) while the snapshot refreshes on
-- public cache misses (often). Sharing one last_id would force the public
-- path to pay for dimensions only the admin dashboard reads.
CREATE TABLE IF NOT EXISTS dim_snapshot (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_id     INTEGER NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL DEFAULT 0
);

-- Claim the high-water mark BEFORE seeding, then seed strictly at or below
-- it. Calls logged during the seed stay unclaimed and fold in on the first
-- refresh - counted exactly once either way.
INSERT OR IGNORE INTO dim_snapshot (id, last_id, computed_at)
  SELECT 1, COALESCE(MAX(id), 0), 0 FROM mcp_calls;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'endpoint', date(ts / 1000, 'unixepoch'), COALESCE(endpoint, ''), '', '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls WHERE id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'tool', date(ts / 1000, 'unixepoch'), tool, '', '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE tool IS NOT NULL AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'error', date(ts / 1000, 'unixepoch'), COALESCE(endpoint, ''), COALESCE(tool, ''),
         COALESCE(error_msg, ''), '', COUNT(*), COUNT(*)
    FROM mcp_calls
   WHERE is_error = 1 AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4, 5;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'errfield', date(ts / 1000, 'unixepoch'), COALESCE(error_msg, ''), COALESCE(endpoint, ''),
         COALESCE(client_name, ua, ''), '', COUNT(*), COUNT(*)
    FROM mcp_calls
   WHERE is_error = 1
     AND (endpoint = 'mcp:tools/call' OR endpoint LIKE 'rest:%')
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4, 5;

-- Handshakes (every mcp:initialize, named or not) plus Poe rows, keyed by
-- endpoint so the two client panels can filter without a second dimension.
INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'client', date(ts / 1000, 'unixepoch'), COALESCE(client_name, ''), COALESCE(endpoint, ''), '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE (endpoint = 'mcp:initialize' OR endpoint LIKE 'poe:%')
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'country', date(ts / 1000, 'unixepoch'), COALESCE(country, ''), '', '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls WHERE id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'restnet', date(ts / 1000, 'unixepoch'), COALESCE(as_org, '(unknown)'), COALESCE(city, ''),
         COALESCE(region, ''), COALESCE(country, ''), COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE endpoint LIKE 'rest:%' AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4, 5, 6;
