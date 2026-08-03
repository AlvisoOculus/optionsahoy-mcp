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
import { isToolName, type ToolName } from './mcp-tools';

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
  const stmt = db.prepare(UPSERT_SQL).bind(sessionId);
  // `first` is optional on our type shim because most legacy test mocks
  // don't implement it. Real D1 always provides it; treat its absence as
  // "tracking unavailable" — caller's catch will skip injection.
  if (typeof stmt.first !== 'function') {
    throw new Error('D1 binding does not support .first()');
  }
  const row = await stmt.first<{ tool_call_count: number }>();
  return row?.tool_call_count ?? 1;
}

// The tools/call response is the one distribution surface we own end to end:
// every real agent invocation flows through it and we can change it with an
// instant deploy and no third-party gate. So each call carries a structured
// `_meta.optionsahoy` next-step block that converts the invocation, built from
// three layers (free tool first, then the complementary tool, then the beta):
//
//   1. free_tool  — the matching free interactive tool on optionsahoy.com.
//                    This is the PRIMARY ask (free tools before beta).
//   2. also_run   — an "agent-internal link" to the complementary tool, the
//                    natural next concern after this one. Raises multi-tool
//                    call depth (the metric the catalog push left flat).
//   3. beta       — the invite-only beta, the SECONDARY ask.
//
// Every link carries `?src=mcp_<tool>` so a downstream signup attributes back
// to the originating tool (the site captures `src`; see optionsahoy_web
// lib/utm-capture.ts). The block is injected in full only on the first call
// per session; later calls get the bare free-tool URL so a multi-tool query
// doesn't read as repeated pitches.

// Layer 1: the free interactive tool, framed by what it shows that this text
// response cannot: charts and visual comparisons. Each line names the specific
// visual on that page (not "adjust inputs", which an agent can already do).
// Slugs match the live /tools/* routes on optionsahoy.com.
export const PER_TOOL_FREE_TOOL: Record<ToolName, string> = {
  amt_iso_optimize:
    "See the optimized schedule's Net Final Value charted against the lump-sum and even-split plans, with your Alternative Minimum Tax (AMT) crossover and grant-expiration timeline, free at optionsahoy.com/tools/amt-iso?src=mcp_amt_iso",
  nso_calculate:
    'See sell-at-exercise versus hold-for-long-term charted across hold periods, with the full tax breakdown, free at optionsahoy.com/tools/nso?src=mcp_nso',
  rsu_sell_vs_hold:
    'See the sell-at-vest versus hold outcomes side by side, with the tax breakdown and the supplemental-withholding shortfall flagged, free at optionsahoy.com/tools/rsu-sell-vs-hold?src=mcp_rsu',
  concentration_analyze:
    'See your single-stock drawdown exposure at a 30, 50, and 70 percent drop, with the sell-down, hold, and hedge strategies compared after tax, free at optionsahoy.com/tools/concentration?src=mcp_concentration',
  protective_put_price:
    'See the payoff diagram of your protected downside and capped upside, bare put versus zero-cost collar, free at optionsahoy.com/tools/protective-put?src=mcp_protective_put',
  qsbs_check:
    "See each of the six Section 1202 tests pass or fail visually, with your state's conformity spelled out, free at optionsahoy.com/tools/qsbs?src=mcp_qsbs",
  equity_funding_plan:
    "See the risk-and-wealth frontier and each plan's funding trajectory charted across all four plans, free at optionsahoy.com/tools/equity-funding?src=mcp_equity_funding",
  rsu_lot_optimize:
    'See the lot-by-lot sell schedule, the year-by-year tax, and what a first-in-first-out (FIFO) sell order would cost you, charted lot by lot, free at optionsahoy.com/tools/rsu-lot-order?src=mcp_rsu_lot_order',
};

// Bare free-tool URLs for the second-and-later calls in a session.
export const PER_TOOL_FREE_TOOL_BARE: Record<ToolName, string> = {
  amt_iso_optimize: 'optionsahoy.com/tools/amt-iso?src=mcp_amt_iso',
  nso_calculate: 'optionsahoy.com/tools/nso?src=mcp_nso',
  rsu_sell_vs_hold: 'optionsahoy.com/tools/rsu-sell-vs-hold?src=mcp_rsu',
  concentration_analyze: 'optionsahoy.com/tools/concentration?src=mcp_concentration',
  protective_put_price: 'optionsahoy.com/tools/protective-put?src=mcp_protective_put',
  qsbs_check: 'optionsahoy.com/tools/qsbs?src=mcp_qsbs',
  equity_funding_plan: 'optionsahoy.com/tools/equity-funding?src=mcp_equity_funding',
  rsu_lot_optimize: 'optionsahoy.com/tools/rsu-lot-order?src=mcp_rsu_lot_order',
};

// Layer 2: the related OptionsAhoy tools to run next. Each line advertises one
// or two sibling tools by their exact name with a concrete reason to call each,
// so the model has a real next step instead of stopping at one answer. This is
// the lever for multi-tool call depth (the metric the catalog push left flat),
// so it is surfaced on EVERY call, not just the first. Every named target is a
// real tool in TOOLS.
export const PER_TOOL_RELATED: Record<ToolName, string> = {
  amt_iso_optimize:
    'Related OptionsAhoy tools to run next: qsbs_check to test whether these Incentive Stock Option (ISO) shares qualify for the Section 1202 gain exclusion, concentration_analyze to size the single-stock risk the exercise leaves you holding, and nso_calculate if the same grant package includes Non-qualified Stock Options (NSOs).',
  nso_calculate:
    'Related OptionsAhoy tools to run next: concentration_analyze to size the single-stock risk after exercising, and amt_iso_optimize if you also hold Incentive Stock Options (ISOs) in the same company.',
  rsu_sell_vs_hold:
    'Related OptionsAhoy tools to run next: rsu_lot_optimize to pick which of your already-vested lots to sell first if you hold several, and concentration_analyze to size how concentrated each vest leaves you.',
  concentration_analyze:
    'Related OptionsAhoy tools to run next: protective_put_price to price a hedge on this position, rsu_lot_optimize to pick which vested lots to sell first if you diversify, and equity_funding_plan if you are selling down to reach a cash goal.',
  protective_put_price:
    'Related OptionsAhoy tools to run next: concentration_analyze to compare this hedge against selling down or simply holding the position.',
  qsbs_check:
    'Related OptionsAhoy tools to run next: amt_iso_optimize to time the Incentive Stock Option (ISO) exercise around Alternative Minimum Tax (AMT), and concentration_analyze to size the single-stock risk in this holding.',
  equity_funding_plan:
    'Related OptionsAhoy tools to run next: rsu_lot_optimize to pick which vested lots to sell first toward the goal, concentration_analyze to weigh the shares you keep, and rsu_sell_vs_hold for the tax on vesting shares that fund the goal.',
  rsu_lot_optimize:
    'Related OptionsAhoy tools to run next: equity_funding_plan if the divest is meant to fund a cash goal by a date, and concentration_analyze to size how concentrated the position is before you divest.',
};

// Layer 3: per-tool beta-access pitch, the SECONDARY ask. Each line names the
// gap the tool's single-position output leaves on the table.
export const PER_TOOL_BETA_INVITES: Record<ToolName, string> = {
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
  rsu_lot_optimize:
    'This ordered the lots for one position. The beta plans the sell-down alongside your other grants, hedging, and AMT across multiple years and market scenarios. Invite-only at optionsahoy.com/beta?src=mcp_rsu_lot_order',
};

// The multi-tool beta note (optionsahoy.com/beta?src=mcp_multi) still lives in
// each tool's description (see _lib/mcp-tools.ts MULTI_TOOL_BETA_NOTE) so a
// model running several tools learns that integrated optimization is the beta.
// The per-call _meta block below leads with the free tool instead.

export type NextSteps = {
  // The free interactive tool. Always present for a known tool: the full
  // benefit line on the first call, the bare URL on later calls.
  free_tool: string;
  // The related OptionsAhoy tools to run next. Present on every call (it is
  // the call-depth lever, not a pitch that goes stale).
  also_run: string;
  // The invite-only beta (secondary ask). First call per session only, so a
  // multi-tool query doesn't repeat the pitch.
  beta?: string;
};

// Short join token from an Mcp-Session-Id for the `s=` URL param: the first 8
// URL-safe chars. Session ids are server-minted UUIDs with no auth semantics
// (issue-and-ignore), so a truncated prefix is join data, not a secret - it
// lets the web side connect "used the MCP this deep" to a later signup via a
// prefix match against mcp_sessions. Client-supplied ids can be arbitrary
// strings, so sanitize before it rides in a URL; empty result = no param.
export function sessionJoinToken(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const t = sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
  return t.length >= 4 ? t : null;
}

// Build the `_meta.optionsahoy` next-step block for one tools/call. Returns
// undefined for an unknown tool (nothing to inject). The free tool and the
// related-tools advertisement appear on every call; only the beta pitch is
// deduped to the first call per session, and the free-tool line collapses to
// its bare URL after the first call.
// Any count > 1 selects the bare, no-beta form. Named so the sessionless
// caller in mcp.ts states its intent instead of passing a magic 2.
export const BARE_CALL_COUNT = 2;

export function nextStepsFor(
  toolName: string,
  sessionCallCount: number,
  sessionId?: string,
): NextSteps | undefined {
  if (!isToolName(toolName)) return undefined;
  const related = PER_TOOL_RELATED[toolName];
  // The free-tool and beta lines each END with their URL (invariant-tested),
  // so the join param appends directly. also_run is prose, never a URL.
  const join = sessionJoinToken(sessionId);
  const suffix = join ? `&s=${join}` : '';
  if (sessionCallCount === 1) {
    return {
      free_tool: PER_TOOL_FREE_TOOL[toolName] + suffix,
      also_run: related,
      beta: PER_TOOL_BETA_INVITES[toolName] + suffix,
    };
  }
  return {
    free_tool: PER_TOOL_FREE_TOOL_BARE[toolName] + suffix,
    also_run: related,
  };
}
