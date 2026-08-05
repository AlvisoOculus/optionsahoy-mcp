// AlphaLatitude Inc. © 2026
//
// Scenario deep links: carry the caller's own arguments to the free web tool
// so they land on their numbers instead of an empty form. Shared by the MCP
// `_meta.optionsahoy.free_tool` link (functions/_lib/sessions.ts) and the
// REST `next_steps.web_tool` link (functions/_lib/api.ts).
//
// This side forwards the calculation's own resolved input and knows nothing
// about any calculator's URL-state keys. The web repo owns the
// interpretation (web/lib/mcpScenario.ts), because that is where the state
// shapes live. Eight hand-copied key maps in this repo is exactly the drift
// class that produced the stale KNOWN_TOOL_SLUGS and submissions.json bugs.
//
// Its own module rather than part of sessions.ts so the REST endpoints can
// use it without pulling mcp-tools.ts (and with it all eight calculators)
// into every route bundle.

import { parseNsoInput } from './calc-parsers';

// Calculator slugs whose page can rehydrate a scenario, mapped to the parser
// that RESOLVES a caller's arguments into the exact input the calculation
// ran on. Phase 1 is `nso` only: 59% of calculator completions (44 of 75 in
// 30d), so it is both the biggest win and the cheapest evidence. A slug added
// here without a matching mapper in the web repo would land users on defaults
// carrying a mystery param, so the two must move together.
//
// Forwarding the RESOLVED input rather than the raw arguments is the whole
// correctness argument, and it was learned the hard way:
//
//   - Several inputs are only conditionally required. `expectedSalePrice`,
//     `volatility` and `expectedMarketReturn` can all be omitted and derived
//     server-side from `ticker` or from defaults. Forwarding raw arguments
//     sent those fields as ABSENT, so the page filled them from its own
//     sources - a different trailing-return window, a chain-derived implied
//     vol at a different horizon - and the visitor landed on a materially
//     different sale price with every other field matching, which reads as
//     authoritative. That is precisely the "wrong numbers" outcome this
//     feature is supposed to be safer than.
//   - It also makes the privacy rule structural instead of aspirational. The
//     parser returns its own declared fields and nothing else, so an extra
//     key a caller tacked onto the request (`clientEmail`, say) cannot ride
//     into a URL handed to an agent. Parsers ignore unknown keys, so the raw
//     body would have carried it verbatim.
const RESOLVERS: Record<string, (raw: unknown) => unknown> = {
  nso: parseNsoInput,
};

export const SCENARIO_SLUGS: ReadonlySet<string> = new Set(Object.keys(RESOLVERS));

// Encoded-payload ceiling. The measured worst case (equity_funding_plan, one
// stack, six lots) is ~850 chars; this leaves headroom under the ~2,000-char
// practical URL limit. Over the cap we emit the bare link rather than a
// truncated one that would decode to garbage.
export const MCP_SCENARIO_MAX_CHARS = 1500;

function base64url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The encoded `mcp=` value for one call, or null when there is nothing safe
// or useful to carry. Never throws: a scenario link is a nice-to-have, and
// the bare link is always a correct answer.
export function encodeScenario(slug: string, args: unknown): string | null {
  // Gate first: seven of the eight tools cannot produce a scenario, and this
  // runs on every tools/call and every REST response.
  const resolve = RESOLVERS[slug];
  if (!resolve) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  try {
    // Re-parsing costs one pass over an object the caller already validated.
    // The alternative - threading the parsed input through two call sites in
    // two servers - buys microseconds and a way to pass the wrong object.
    const json = JSON.stringify(resolve(args));
    // Undefined (non-serializable) or an empty object carries no scenario.
    if (!json || json === '{}') return null;
    const encoded = base64url(json);
    return encoded.length > MCP_SCENARIO_MAX_CHARS ? null : encoded;
  } catch {
    // Includes the parser throwing. A caller whose arguments do not resolve
    // has no scenario worth carrying.
    return null;
  }
}

// Every link form ends with `?src=<bucket>` (invariant-tested on both
// surfaces), so the scenario variant appends `_sc` to that bucket and then
// the payload. The distinct bucket IS the measurement: it lets the funnel
// compare completion rates of scenario-carrying arrivals against bare ones
// with no new columns. If the shape ever changes the regex misses and the
// bare link goes out unchanged.
const SRC_TAIL_RE = /\?src=[a-z_]+$/;

export function withScenario(line: string, payload: string | null): string {
  if (!payload || !SRC_TAIL_RE.test(line)) return line;
  return `${line}_sc&mcp=${payload}`;
}
