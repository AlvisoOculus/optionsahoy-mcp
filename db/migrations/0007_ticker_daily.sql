-- AlphaLatitude Inc. © 2026
--
-- Daily counts of the tickers callers name, per tool and outcome: the demand
-- signal for market-data coverage (see functions/_lib/ticker-demand.ts).
--
-- Counts only. There is deliberately no per-call row, no client and no
-- location here: the table answers "which symbols do people ask about, and
-- could we serve them", and nothing that ties a symbol to a caller. Written
-- by functions/_lib/stats.ts (countTickers) as an upsert per ticker per call,
-- in a batch of its own so the call log never depends on this table.
--
-- outcome: ok | fallback | error (definitions in ticker-demand.ts).
-- Every key column is NOT NULL so the PRIMARY KEY accumulates (see 0006).
--
-- Apply remotely:
--   npx wrangler d1 execute optionsahoy-mcp-stats --remote \
--     --file=db/migrations/0007_ticker_daily.sql

CREATE TABLE IF NOT EXISTS mcp_ticker_daily (
  day     TEXT NOT NULL,     -- YYYY-MM-DD, UTC
  ticker  TEXT NOT NULL,     -- upper-cased symbol
  tool    TEXT NOT NULL,     -- tool name, or the endpoint when no tool resolved
  outcome TEXT NOT NULL,     -- ok | fallback | error
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ticker, tool, outcome)
);

CREATE INDEX IF NOT EXISTS idx_mcp_ticker_daily_day ON mcp_ticker_daily(day);
