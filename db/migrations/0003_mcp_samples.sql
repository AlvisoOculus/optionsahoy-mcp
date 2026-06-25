-- AlphaLatitude Inc. © 2026
--
-- A rolling 7-day sample of REAL inputs and outputs across all surfaces (Poe,
-- MCP, REST), captured for product feedback: there is no other way to see what
-- users actually ask or what we return. Unlike mcp_calls (metadata only), this
-- table DOES store query + answer text, so it contains users' financial details
-- (share counts, income, holdings). It is therefore:
--   - viewable only behind ADMIN_TOKEN on the off-domain pages.dev admin page,
--   - pruned to a rolling 7-day window on every write (see logSamples), and
--   - written only for SUCCESSFUL calls (valid input that actually computed),
--     so probe/fuzzer noise is excluded.
--
-- Apply remotely:
--   npx wrangler d1 execute optionsahoy-mcp-stats --remote \
--     --file=db/migrations/0003_mcp_samples.sql

CREATE TABLE IF NOT EXISTS mcp_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  surface TEXT NOT NULL,      -- poe | mcp | rest
  tool TEXT,
  client_name TEXT,
  query TEXT,                 -- user input / recent transcript (truncated)
  answer TEXT                 -- rendered answer / result JSON (truncated)
);

CREATE INDEX IF NOT EXISTS idx_mcp_samples_ts ON mcp_samples(ts);
CREATE INDEX IF NOT EXISTS idx_mcp_samples_surface_ts ON mcp_samples(surface, ts);
