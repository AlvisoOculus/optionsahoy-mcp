// AlphaLatitude Inc. © 2026
//
// Shared client classification. Single source of truth used by BOTH the admin
// dashboard (functions/admin/mcp-stats.ts, for display) and the 7-day example
// capture (functions/_lib/stats.ts, to keep infrastructure noise out of the
// samples table). Keep the patterns here only — duplicating them would let the
// two surfaces drift.
//
// Heuristic, NOT proof. The signal is client_name: the MCP handshake
// clientInfo.name for mcp: calls, the literal 'poe' for Poe, or the raw
// (spoofable) User-Agent for rest: calls.

export type ClientKind = 'human' | 'agent' | 'smoke' | 'tool' | 'crawler' | 'unknown';

// Display order on the dashboard: most-valuable (a real person, then an
// automated agent) first.
export const KIND_RANK: Record<ClientKind, number> = {
  human: 0, agent: 1, unknown: 2, tool: 3, smoke: 4, crawler: 5,
};

export function classifyClient(
  clientName: string | null | undefined,
  surface: string,
): { kind: ClientKind; label: string } {
  const c = (clientName ?? '').trim().toLowerCase();
  // Our own synthetic monitors (REST uptime smoke + the live MCP e2e check).
  if (c.includes('optionsahoy-smoke') || c.includes('oa-e2e-live')) return { kind: 'smoke', label: 'smoke test' };
  // A person typed into the Poe consumer bot.
  if (surface === 'poe' || c === 'poe') return { kind: 'human', label: 'human (Poe)' };
  // Web crawlers / training bots / security scanners, plus the swarm of MCP
  // directory probes and registry crawlers that constantly re-introspect any
  // listed server (probe/scan/registry/inspect/discover/verify/audit/scoring).
  // Checked before the interactive list so 'claudebot' (Anthropic's crawler) is
  // not confused with 'Claude-User' (a real person driving Claude). Scanners
  // that name themselves after their research TOPIC rather than a scanner verb
  // (prod case: 'mcp-rugpull-research', a periodic tools/list differ) must be
  // matched here explicitly, or the \bmcp- agent catch-all below adopts them.
  // The catalog/validator/monitor terms come from a 2026-08-06 audit of the
  // 30-day realClients list: ~20% of "real" connects were mcp-* robots
  // (prsm-mcp-graph, agentage-mcp-catalog-health, mcp-uptime, mcp-scraper,
  // kimi-mcp-validator, ...). Deliberately ABSENT: bare 'graph' (LangGraph),
  // bare 'index' (llama-index), bare 'health'/'test'/'client'.
  if (/\b(bot|crawler|spider)\b|gptbot|oai-searchbot|claudebot|google-extended|googlebot|bingbot|applebot|slurp|duckduckbot|yandex|baiduspider|semrush|ahrefs|mj12|dotbot|petalbot|nuclei|zgrab|masscan|censys|shodan|nmap|sqlmap|probe|prober|scan|registr|inspect|introspect|discover|verif|audit|scoring|rug-?pull|catalog|uptime|indexer|scraper|validat|survey|spec-check|vouch|trust-index|detector|\bguard\b|prsm|prism/.test(c))
    return { kind: 'crawler', label: 'crawler/scanner' };
  // Interactive AI clients: a real person is in the loop (chat UI, IDE,
  // desktop app). 'Claude-User' is the name Claude.ai sends for a
  // user-initiated tool call, so it counts as a human, not an automated agent.
  if (/claude-user|claude\.ai|claude-desktop|claude-code|chatgpt-user|chatgpt|cursor|cline|roo|windsurf|continue|zed|librechat|witsy|cherry|chatwise|5ire|highlight|tome|copilot|vscode|jetbrains/.test(c))
    return { kind: 'human', label: 'human (AI assistant)' };
  // Programmatic AI agent frameworks / SDKs: an automated caller that may have
  // no person watching the loop.
  if (/langchain|langgraph|llama-?index|crewai|fast-?agent|anthropic|openai|\bmcp-|autogpt|agno|smolagents|pydantic-ai|vercel-ai/.test(c))
    return { kind: 'agent', label: 'AI agent' };
  // Generic programmatic HTTP clients: a dev test or an unknown integration.
  if (c === '') return { kind: 'tool', label: 'no UA (script)' };
  if (/curl|wget|python-requests|python-httpx|httpx|aiohttp|node-fetch|undici|axios|okhttp|go-http-client|java\/|apache-httpclient|libwww|postmanruntime|insomnia|restsharp|guzzle|httpie/.test(c))
    return { kind: 'tool', label: 'script/tool' };
  // A raw browser UA hitting the JSON API directly: real browsers don't, so
  // this is a manual test (Postman-as-browser) or a script with a copied UA.
  if (/mozilla\/|chrome\/|safari\/|firefox\/|webkit/.test(c))
    return { kind: 'tool', label: 'browser/manual' };
  return { kind: 'unknown', label: 'unknown' };
}

// "Real" for ADOPTION counting: a person in an AI client, or a programmatic
// agent framework. Deliberately and strictly NARROWER than !isInfraClient():
// that one only drops smoke + crawlers and still admits 'tool' (bare scripts,
// SDK user-agents like python-httpx) and 'unknown'. The two are not
// complements, and the gap is meaningful - an SDK integration is worth
// showing a free-tool link to (so it passes the injection gate) without
// counting as a named client connect in the funnel's adoption figure.
export function isRealClient(clientName: string | null | undefined, surface: string): boolean {
  const kind = classifyClient(clientName, surface).kind;
  return kind === 'human' || kind === 'agent';
}

// Infrastructure = automated noise we never want polluting the 7-day example
// capture or the "real engagement" counts: our own smoke suite plus registry
// crawlers and security scanners.
export function isInfraClient(clientName: string | null | undefined, surface: string): boolean {
  const kind = classifyClient(clientName, surface).kind;
  return kind === 'smoke' || kind === 'crawler';
}
