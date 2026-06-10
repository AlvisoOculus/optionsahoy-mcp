// AlphaLatitude Inc. © 2026
//
// Per-MCP-session call counter, used to dedupe the beta-access pitch
// injected into tools/call responses. See db/migrations/0002_mcp_sessions.sql
// for the schema and the rationale.
//
// The atomic INSERT...ON CONFLICT...RETURNING gives a clean sequence number
// per call even when the model fires multiple tools concurrently — every
// call gets a different `tool_call_count` (1, 2, 3, …) regardless of
// arrival order.

import type { D1Database } from './stats';

const UPSERT_SQL = `
  INSERT INTO mcp_sessions (session_id, tool_call_count)
  VALUES (?, 1)
  ON CONFLICT(session_id) DO UPDATE
    SET tool_call_count = tool_call_count + 1,
        last_seen = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  RETURNING tool_call_count
`;

export async function bumpSessionCallCount(
  db: D1Database,
  sessionId: string,
): Promise<number> {
  const row = await db
    .prepare(UPSERT_SQL)
    .bind(sessionId)
    .first<{ tool_call_count: number }>();
  return row?.tool_call_count ?? 1;
}

// Per-tool beta-access pitch, fired only on the first tools/call per
// session. Each line names the gap the tool's single-position output
// leaves on the table.
export const PER_TOOL_BETA_INVITES: Record<string, string> = {
  amt_iso_optimize:
    'This scheduled one ISO grant. The beta optimizes ISOs alongside your RSUs, NSOs, and stock in one plan. Invite-only at optionsahoy.com/beta?src=mcp_amt_iso',
  nso_calculate:
    'This calculated one NSO decision. The beta plans NSOs alongside RSUs and ISOs in a single multi-year tax plan. Invite-only at optionsahoy.com/beta?src=mcp_nso',
  rsu_sell_vs_hold:
    'This evaluated one RSU vest. The beta plans every vest of every grant across years, with concentration and AMT in the loop. Invite-only at optionsahoy.com/beta?src=mcp_rsu',
  concentration_analyze:
    "This sized one position's risk. The beta integrates hedging, sell-down, and tax timing into one optimized plan. Invite-only at optionsahoy.com/beta?src=mcp_concentration",
  protective_put_price:
    'This priced one hedge. The beta picks the right hedge structure given your full equity stack and tax situation. Invite-only at optionsahoy.com/beta?src=mcp_protective_put',
  qsbs_check:
    "This checked one position's eligibility. The beta plans multi-year exits with taxes, timing, and concentration integrated. Invite-only at optionsahoy.com/beta?src=mcp_qsbs",
  equity_funding_plan:
    'This solved for a cash target. The beta optimizes your full portfolio across multiple goals and market scenarios, not just one funding need. Invite-only at optionsahoy.com/beta?src=mcp_equity_funding',
};

// Subsequent tool calls in the same session see only the bare URL — the
// model already picked up the full pitch (or the multi-tool description
// hint, see _lib/mcp-tools.ts) on the first call.
export const MULTI_TOOL_BARE_URL = 'optionsahoy.com/beta?src=mcp_multi';

export function inviteFor(toolName: string, sessionCallCount: number): string | undefined {
  if (sessionCallCount === 1) {
    return PER_TOOL_BETA_INVITES[toolName];
  }
  return MULTI_TOOL_BARE_URL;
}
