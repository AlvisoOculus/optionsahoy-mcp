-- AlphaLatitude Inc. © 2026
--
-- Removes the 2026-09-05 GET reconnect loop from the call log and rebuilds
-- every counter derived from it.
--
-- What happened: one Copilot CLI session sent ~23,500 GET /mcp requests in a
-- day because the server answered a stream request with 200 + a descriptor
-- instead of the 405 the spec requires (fixed in #249, which also stopped
-- logging stream probes entirely). Those rows are transport chatter under
-- the current logging policy, and they were 83% of a public-facing counter:
-- /for-agents read 28,277 calls in 24 hours when real tool invocations were
-- 85. Deleting them makes the history consistent with how the same requests
-- are treated today - not logged at all.
--
-- Scope is deliberately narrow: only that client's GETs, only inside the
-- loop window. Ordinary discovery GETs (a person opening /mcp in a browser)
-- are still logged today and stay in the log.
--
-- Run AFTER a daily write-limit reset: deleting ~23,500 rows costs roughly
-- twice that in rows_written, and the free tier allows 100,000 per day.

DELETE FROM mcp_calls
 WHERE endpoint = 'mcp:GET'
   AND ua LIKE 'copilot-darwin-arm64%'
   AND ts >= (strftime('%s', '2026-09-05') * 1000);

-- Counters are recomputed from the surviving rows, never adjusted by hand.
UPDATE stats_snapshot
   SET total = (SELECT COUNT(*) FROM mcp_calls WHERE id <= (SELECT last_id FROM stats_snapshot WHERE id = 1))
 WHERE id = 1;

DELETE FROM mcp_tool_counts;
INSERT INTO mcp_tool_counts (tool, n)
  SELECT tool, COUNT(*) FROM mcp_calls
   WHERE tool IS NOT NULL AND id <= (SELECT last_id FROM stats_snapshot WHERE id = 1)
   GROUP BY tool;

DELETE FROM mcp_daily;
INSERT INTO mcp_daily (day, n)
  SELECT date(ts / 1000, 'unixepoch'), COUNT(*) FROM mcp_calls
   WHERE id <= (SELECT last_id FROM stats_snapshot WHERE id = 1)
   GROUP BY 1;

DELETE FROM mcp_hourly;
INSERT INTO mcp_hourly (hour_ts, n)
  SELECT (ts / 3600000) * 3600000, COUNT(*) FROM mcp_calls
   WHERE ts >= (strftime('%s', 'now') - 172800) * 1000
     AND id <= (SELECT last_id FROM stats_snapshot WHERE id = 1)
   GROUP BY 1;

-- The dimensional buckets counted those rows too, across several dimensions
-- (endpoint and country at minimum). Rebuilding the affected days wholesale
-- is simpler than reasoning about which dimensions saw them, and cheap: a
-- couple of hundred buckets.
DELETE FROM mcp_dim_daily WHERE day >= '2026-09-05';

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'endpoint', date(ts / 1000, 'unixepoch'), COALESCE(endpoint, ''), '', '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE date(ts / 1000, 'unixepoch') >= '2026-09-05'
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'tool', date(ts / 1000, 'unixepoch'), tool, '', '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE tool IS NOT NULL AND date(ts / 1000, 'unixepoch') >= '2026-09-05'
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'error', date(ts / 1000, 'unixepoch'), COALESCE(endpoint, ''), COALESCE(tool, ''),
         COALESCE(error_msg, ''), '', COUNT(*), COUNT(*)
    FROM mcp_calls
   WHERE is_error = 1 AND date(ts / 1000, 'unixepoch') >= '2026-09-05'
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4, 5;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'errfield', date(ts / 1000, 'unixepoch'), COALESCE(error_msg, ''), COALESCE(endpoint, ''),
         COALESCE(client_name, ua, ''), '', COUNT(*), COUNT(*)
    FROM mcp_calls
   WHERE is_error = 1
     AND (endpoint = 'mcp:tools/call' OR endpoint LIKE 'rest:%')
     AND date(ts / 1000, 'unixepoch') >= '2026-09-05'
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4, 5;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'client', date(ts / 1000, 'unixepoch'), COALESCE(client_name, ''), COALESCE(endpoint, ''), '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE (endpoint = 'mcp:initialize' OR endpoint LIKE 'poe:%')
     AND date(ts / 1000, 'unixepoch') >= '2026-09-05'
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'country', date(ts / 1000, 'unixepoch'), COALESCE(country, ''), '', '', '',
         COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE date(ts / 1000, 'unixepoch') >= '2026-09-05'
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3;

INSERT OR IGNORE INTO mcp_dim_daily (dim, day, k1, k2, k3, k4, n, errors)
  SELECT 'restnet', date(ts / 1000, 'unixepoch'), COALESCE(as_org, '(unknown)'), COALESCE(city, ''),
         COALESCE(region, ''), COALESCE(country, ''), COUNT(*), COALESCE(SUM(is_error), 0)
    FROM mcp_calls
   WHERE endpoint LIKE 'rest:%' AND date(ts / 1000, 'unixepoch') >= '2026-09-05'
     AND id <= (SELECT last_id FROM dim_snapshot WHERE id = 1)
   GROUP BY 2, 3, 4, 5, 6;
