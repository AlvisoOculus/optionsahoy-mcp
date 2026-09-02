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
//
// Always returns HTTP 200 (even on missing binding or unknown metric) so the
// badge still renders rather than showing shields' "inaccessible" error.

import { ensureFresh, readWindows } from '../../_lib/statsRollup';
import { type PagesFunction } from '../../_lib/api';
import { type D1Database } from '../../_lib/stats';

// Rollup-backed (see _lib/statsRollup.ts): shields.io and registry
// caches poll this endpoint from many vantage points, and its former
// COUNT(*) full scans per poll were a top contributor to the 2026-09-01
// free-tier read outage. A badge poll now costs ~a snapshot row.

interface MetricDef {
  label: string;
  value: (db: D1Database, now: number) => Promise<number>;
}

const METRICS: Record<string, MetricDef> = {
  calls30d: {
    label: 'MCP calls (30d)',
    value: async (db, now) => {
      await ensureFresh(db, now);
      return (await readWindows(db, now)).last30d;
    },
  },
  calls: {
    label: 'MCP calls',
    value: async (db, now) => (await ensureFresh(db, now)).total,
  },
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

  const n = await def.value(db, Date.now());

  return badge(def.label, humanize(n), 'blue');
};
