-- AlphaLatitude Inc. © 2026
--
-- Per-MCP-session call counter, used to dedupe the per-tool beta-access
-- pitch injected into tools/call responses. The pitch fires only on the
-- first call per session; subsequent calls get a bare URL so a multi-tool
-- query (e.g. ISO + RSU + concentration in one analysis) doesn't read as
-- three identical pitches.
--
-- Session ID comes from the `Mcp-Session-Id` header that the Streamable
-- HTTP transport sets per client connection.
--
-- Apply remotely:
--   npx wrangler d1 execute optionsahoy-mcp-stats --remote \
--     --file=db/migrations/0002_mcp_sessions.sql

CREATE TABLE IF NOT EXISTS mcp_sessions (
  session_id      TEXT    PRIMARY KEY,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  first_seen      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Supports the nightly cleanup of stale sessions (any session whose last
-- tool call was >24h ago can be purged — the dedup window has elapsed).
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_last_seen ON mcp_sessions(last_seen);
