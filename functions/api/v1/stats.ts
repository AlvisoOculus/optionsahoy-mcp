// AlphaLatitude Inc. © 2026
//
// GET /api/v1/stats
//
// Public, read-only summary over MCP_STATS. PII-safe (no user agents,
// IPs, args, error messages); only counts and the most-called tool list
// leave the building. Returned shape is intended for static-page social
// proof — the /for-agents banner pulls from this endpoint.
//
// Cache-Control caps origin pressure on D1: edge serves cached responses
// for 60 seconds before the next read. The numbers move slowly enough
// that 60s lag is invisible to a human reader.

import { type PagesFunction } from '../../_lib/api';
import { type D1Database } from '../../_lib/stats';

interface ToolRow {
  tool: string;
  n: number;
}
interface CountRow {
  n: number;
}
interface LastRow {
  ts: number;
}

const TOP_TOOLS_LIMIT = 5;

const SQL_TOTAL = 'SELECT COUNT(*) AS n FROM mcp_calls';
const SQL_SINCE = 'SELECT COUNT(*) AS n FROM mcp_calls WHERE ts >= ?';
const SQL_DISTINCT_CLIENTS_SINCE =
  'SELECT COUNT(DISTINCT client_name) AS n FROM mcp_calls WHERE client_name IS NOT NULL AND ts >= ?';
const SQL_TOP_TOOLS = `SELECT tool, COUNT(*) AS n FROM mcp_calls WHERE tool IS NOT NULL GROUP BY tool ORDER BY n DESC LIMIT ${TOP_TOOLS_LIMIT}`;
const SQL_LAST_TS = 'SELECT ts FROM mcp_calls ORDER BY ts DESC LIMIT 1';

async function scalar(db: D1Database, sql: string, sinceMs?: number): Promise<number> {
  const stmt = sinceMs == null ? db.prepare(sql) : db.prepare(sql).bind(sinceMs);
  const res = await stmt.all<CountRow>();
  return res.results[0]?.n ?? 0;
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export const onRequest: PagesFunction = async (ctx) => {
  if (ctx.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (ctx.request.method !== 'GET') {
    return new Response('method not allowed', { status: 405, headers: CORS });
  }

  const db = ctx.env?.MCP_STATS;
  if (!db) {
    return new Response(JSON.stringify({ error: 'stats unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }

  const now = Date.now();
  const day = 86_400_000;
  const since24h = now - day;
  const since7d = now - 7 * day;
  const since30d = now - 30 * day;

  const [total, last24h, last7d, last30d, clients30d, topToolsRes, lastRes] = await Promise.all([
    scalar(db, SQL_TOTAL),
    scalar(db, SQL_SINCE, since24h),
    scalar(db, SQL_SINCE, since7d),
    scalar(db, SQL_SINCE, since30d),
    scalar(db, SQL_DISTINCT_CLIENTS_SINCE, since30d),
    db.prepare(SQL_TOP_TOOLS).all<ToolRow>(),
    db.prepare(SQL_LAST_TS).all<LastRow>(),
  ]);

  const lastCallAt = lastRes.results[0]?.ts
    ? new Date(lastRes.results[0].ts).toISOString()
    : null;

  const payload = {
    totalCalls: total,
    last24h,
    last7d,
    last30d,
    distinctClients30d: clients30d,
    topTools: topToolsRes.results.map((r) => ({ name: r.tool, count: r.n })),
    lastCallAt,
    asOf: new Date(now).toISOString(),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, s-maxage=60',
      ...CORS,
    },
  });
};
