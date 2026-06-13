// AlphaLatitude Inc. © 2026
//
// GET /api/v1/badge?metric=<name>
//
// Shields.io "endpoint" badge source. Returns the schemaVersion-1 JSON that
// https://img.shields.io/endpoint?url=... renders into an SVG badge, so the
// README can show live MCP usage with no build step and no hand-maintained
// number — shields fetches this server-side on its own cache cycle.
//
// PII-safe: only aggregate counts leave the building (same data class as
// /api/v1/stats). No token, no per-client detail, no args.
//
// Supported metrics:
//   calls30d   - MCP + REST calls in the last 30 days (default)
//   calls      - all-time calls
//   clients30d - distinct agent clients in the last 30 days
//
// Always returns HTTP 200 (even on missing binding or unknown metric) so the
// badge still renders rather than showing shields' "inaccessible" error.

import { type PagesFunction } from '../../_lib/api';
import { type D1Database } from '../../_lib/stats';

interface CountRow {
  n: number;
}

const DAY = 86_400_000;

const SQL_TOTAL = 'SELECT COUNT(*) AS n FROM mcp_calls';
const SQL_CALLS_SINCE = 'SELECT COUNT(*) AS n FROM mcp_calls WHERE ts >= ?';
const SQL_CLIENTS_SINCE =
  'SELECT COUNT(DISTINCT client_name) AS n FROM mcp_calls WHERE client_name IS NOT NULL AND ts >= ?';

interface MetricDef {
  label: string;
  sql: string;
  sinceMs?: number; // lookback window; omit for all-time
}

const METRICS: Record<string, MetricDef> = {
  calls30d: { label: 'MCP calls (30d)', sql: SQL_CALLS_SINCE, sinceMs: 30 * DAY },
  calls: { label: 'MCP calls', sql: SQL_TOTAL },
  clients30d: { label: 'agent clients (30d)', sql: SQL_CLIENTS_SINCE, sinceMs: 30 * DAY },
};

// 8793 -> "8.8k", 950 -> "950", 1_500_000 -> "1.5M"
function humanize(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + 'k';
  }
  const m = n / 1_000_000;
  return (m < 10 ? m.toFixed(1) : Math.round(m).toString()) + 'M';
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function badge(label: string, message: string, color: string): Response {
  return new Response(JSON.stringify({ schemaVersion: 1, label, message, color }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Shields caches on its own; 5 min here keeps D1 read pressure trivial.
      'cache-control': 'public, max-age=300, s-maxage=300',
      ...CORS,
    },
  });
}

export const onRequest: PagesFunction = async (ctx) => {
  if (ctx.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (ctx.request.method !== 'GET') {
    return new Response('method not allowed', { status: 405, headers: CORS });
  }

  const url = new URL(ctx.request.url);
  const def = METRICS[url.searchParams.get('metric') ?? 'calls30d'];
  if (!def) {
    return badge('mcp', 'unknown metric', 'lightgrey');
  }

  const db = ctx.env?.MCP_STATS;
  if (!db) {
    return badge(def.label, 'n/a', 'lightgrey');
  }

  const stmt =
    def.sinceMs == null ? db.prepare(def.sql) : db.prepare(def.sql).bind(Date.now() - def.sinceMs);
  const res = await stmt.all<CountRow>();
  const n = res.results[0]?.n ?? 0;

  return badge(def.label, humanize(n), 'blue');
};
