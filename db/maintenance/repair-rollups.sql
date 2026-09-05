-- AlphaLatitude Inc. © 2026
--
-- One-shot repair for rollup drift, and the reference recipe if it ever
-- recurs. Safe to re-run: it recomputes counters from the raw log rather
-- than adjusting them.
--
-- Why it was needed once: between migration 0005 and the fix in #247, the
-- refresh ran its four aggregates in parallel - one computed the MAX(id)
-- that became the next cursor while the others read `id > last_id` with no
-- ceiling. The two windows were therefore not the same window, and whichever
-- query D1 executed first decided the boundary. In production the dimension
-- queries usually landed first, so rows between their read and the cursor's
-- read were never counted: the per-tool and per-day counters ran 1-14 calls
-- light (measured 2026-09-05, ten tools affected, worst -14 on 1,574).
-- Totals were unaffected. The reverse ordering would have double-counted
-- instead; #247 bounds every dimension query by the claimed high-water mark
-- so neither can happen.
--
-- Every statement is bounded by the SAME stats_snapshot.last_id, so calls
-- arriving mid-repair stay unclaimed and fold in normally afterwards.

-- Lifetime total.
UPDATE stats_snapshot
   SET total = (SELECT COUNT(*) FROM mcp_calls WHERE id <= (SELECT last_id FROM stats_snapshot WHERE id = 1))
 WHERE id = 1;

-- Per-tool counters (these feed the public /api/v1/stats topTools list).
DELETE FROM mcp_tool_counts;
INSERT INTO mcp_tool_counts (tool, n)
  SELECT tool, COUNT(*) FROM mcp_calls
   WHERE tool IS NOT NULL AND id <= (SELECT last_id FROM stats_snapshot WHERE id = 1)
   GROUP BY tool;

-- Per-day counters (the /mcp/usage curve and the 7d/30d windows).
DELETE FROM mcp_daily;
INSERT INTO mcp_daily (day, n)
  SELECT date(ts / 1000, 'unixepoch'), COUNT(*) FROM mcp_calls
   WHERE id <= (SELECT last_id FROM stats_snapshot WHERE id = 1)
   GROUP BY 1;

-- Hourly buckets serve the rolling 24h only, and the refresh prunes past
-- 48h; rebuild just that tail.
DELETE FROM mcp_hourly;
INSERT INTO mcp_hourly (hour_ts, n)
  SELECT (ts / 3600000) * 3600000, COUNT(*) FROM mcp_calls
   WHERE ts >= (strftime('%s', 'now') - 172800) * 1000
     AND id <= (SELECT last_id FROM stats_snapshot WHERE id = 1)
   GROUP BY 1;
