-- AlphaLatitude Inc. © 2026
--
-- One row per inbound MCP or REST call. Written async via ctx.waitUntil
-- from functions/_lib/stats.ts. Tool args are intentionally NOT logged:
-- both for privacy (filing status, income, ticker holdings) and to keep
-- row size bounded.
--
-- Apply remotely:
--   npx wrangler d1 execute optionsahoy-mcp-stats --remote \
--     --file=db/migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  tool TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  error_msg TEXT,
  client_name TEXT,
  ua TEXT,
  country TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_calls_ts ON mcp_calls(ts);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_endpoint_ts ON mcp_calls(endpoint, ts);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_tool_ts ON mcp_calls(tool, ts) WHERE tool IS NOT NULL;
