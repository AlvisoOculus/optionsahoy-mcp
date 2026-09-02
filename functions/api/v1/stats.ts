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

import { ensureFresh, readWindows, readTopTools } from '../../_lib/statsRollup';
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
  // Rollup-backed (see _lib/statsRollup.ts): the numbers stay 60-second
  // live, but a refresh reads only the rows that arrived since the last
  // one instead of scanning the whole call log - the scans behind the
  // 2026-09-01 free-tier read outage.
  const snap = await ensureFresh(db, now);
  const [windows, top] = await Promise.all([
    readWindows(db, now),
    readTopTools(db, TOP_TOOLS_LIMIT),
  ]);

  const payload = {
    totalCalls: snap.total,
    last24h: windows.last24h,
    last7d: windows.last7d,
    last30d: windows.last30d,
    topTools: top.map((r) => ({ name: r.tool, count: r.n })),
    lastCallAt: snap.last_ts ? new Date(snap.last_ts).toISOString() : null,
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
