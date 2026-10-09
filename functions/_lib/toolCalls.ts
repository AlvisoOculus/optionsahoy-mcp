// AlphaLatitude Inc. © 2026
//
// The public usage number: successful tool calls from real callers.
//
// /api/v1/stats used to publish every message the server logged, and on
// 2026-10-08 its "last 24 hours" read 14,682 while real usage was a few dozen
// calls: 11,341 were keep-alive pings from one GitHub Copilot CLI connection,
// the rest handshakes, scanners, our own monitors and an A2A poller. This
// counts what a reader takes "calls" to mean: an MCP tools/call or a REST
// calculator call that returned a result, from a caller that is neither our
// monitoring nor a crawler or scanner (isInfraClient, the same rule as the
// admin page's real-traffic table).
//
// Read from the daily per-caller rollup (mcp_dim_daily, dim 'callclient'), so
// a refresh costs a few hundred rows and the windows are whole UTC days.
import { ensureDimsFresh, readToolCallRows } from './adminRollup';
import { isInfraClient, surfaceOf } from './classify';
import { type D1Database } from './stats';

export interface ToolCallStats {
  last7d: number;
  last30d: number;
}

/** A logged endpoint that ran a calculator. */
export function isToolCallEndpoint(endpoint: string): boolean {
  return endpoint === 'mcp:tools/call' || endpoint.startsWith('rest:');
}

/** UTC day `daysBack` days before `now`, as YYYY-MM-DD. */
const dayBefore = (now: number, daysBack: number) => new Date(now - daysBack * 86_400_000).toISOString().slice(0, 10);

export function toolCallStatsFrom(
  rows: { day: string; endpoint: string; client: string; n: number; errors: number }[],
  now: number,
): ToolCallStats {
  // Inclusive of today: 7 and 30 calendar days.
  const from7 = dayBefore(now, 6);
  const out: ToolCallStats = { last7d: 0, last30d: 0 };
  for (const r of rows) {
    if (!isToolCallEndpoint(r.endpoint) || isInfraClient(r.client, surfaceOf(r.endpoint))) continue;
    const ok = r.n - r.errors;
    out.last30d += ok;
    if (r.day >= from7) out.last7d += ok;
  }
  return out;
}

export async function readToolCallStats(db: D1Database, now: number): Promise<ToolCallStats> {
  await ensureDimsFresh(db, now);
  return toolCallStatsFrom(await readToolCallRows(db, dayBefore(now, 29)), now);
}
