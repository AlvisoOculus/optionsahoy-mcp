// AlphaLatitude Inc. © 2026
//
// GET /admin/mcp-stats?token=<ADMIN_TOKEN>&days=<N>[&format=json]
//
// Token-gated dashboard for the MCP_STATS D1 table. Default 30-day window.
// Returns plain HTML tables — no JS, no auth flow, no cookies. Andrew is
// the only intended consumer; bookmark the URL with the token in the query
// string. format=json returns the same data as a JSON document; the ops
// repo's daily snapshot job consumes it to build a local time series.
//
// Reachable directly on the Pages dev URL:
//   https://optionsahoy-mcp.pages.dev/admin/mcp-stats?token=...
// The worker-proxy only forwards /mcp* and /api/v1/*, so this path stays
// off the public optionsahoy.com domain on purpose.

import { type PagesFunction } from '../_lib/api';
import { type D1Database } from '../_lib/stats';

interface EndpointRow { endpoint: string; n: number }
interface DayRow { day: string; n: number }
interface ToolRow { tool: string; n: number; errors: number }
interface ErrorRow { endpoint: string; tool: string | null; error_msg: string; n: number }
interface ClientRow { client_name: string; n: number }
interface CountryRow { country: string | null; n: number }
interface SampleRow { ts: number; surface: string; tool: string | null; client_name: string | null; query: string | null; answer: string | null }

// --- real-vs-bot classification of a captured example -----------------------
//
// Heuristic, NOT proof. The signal we classify on (client_name) is:
//   - the MCP handshake clientInfo.name for mcp: calls (e.g. 'Claude-User'),
//   - the literal 'poe' for Poe (a human typed into the consumer bot),
//   - the raw User-Agent for rest: calls, which is trivially spoofable.
// Two structural facts make the heuristic usable anyway: (1) only successful,
// valid-input calls are written to mcp_samples, so the worst fuzzer/probe
// noise (which fails input validation) never appears here; (2) our own smoke
// monitor sends a distinctive UA, so synthetic traffic self-identifies.
export type ClientKind = 'human' | 'assistant' | 'smoke' | 'tool' | 'crawler' | 'unknown';

// Display order on the dashboard: most-valuable (a real person/agent) first.
export const KIND_RANK: Record<ClientKind, number> = {
  human: 0, assistant: 1, unknown: 2, tool: 3, smoke: 4, crawler: 5,
};

export function classifyClient(
  clientName: string | null | undefined,
  surface: string,
): { kind: ClientKind; label: string } {
  const c = (clientName ?? '').trim().toLowerCase();
  // Our own synthetic monitor (data/agent-campaign smoke + uptime checks).
  if (c.includes('optionsahoy-smoke')) return { kind: 'smoke', label: 'smoke test' };
  // A person typed into the Poe consumer bot.
  if (surface === 'poe' || c === 'poe') return { kind: 'human', label: 'human (Poe)' };
  // Web crawlers / training bots / security scanners. Checked before the
  // assistant list so 'claudebot' (Anthropic's crawler) is not confused with
  // 'Claude-User' (a real person driving Claude).
  if (/\b(bot|crawler|spider)\b|gptbot|oai-searchbot|claudebot|google-extended|googlebot|bingbot|applebot|slurp|duckduckbot|yandex|baiduspider|semrush|ahrefs|mj12|dotbot|petalbot|nuclei|zgrab|masscan|censys|shodan|nmap|sqlmap/.test(c))
    return { kind: 'crawler', label: 'crawler/scanner' };
  // Recognized real AI assistant / agent clients (a real user is behind one).
  if (/claude-user|claude\.ai|claude-code|claude-desktop|anthropic|chatgpt-user|chatgpt|openai|cursor|cline|roo|windsurf|continue|zed|librechat|goose|witsy|cherry|chatwise|5ire|fast-?agent|highlight|tome|copilot|vscode|jetbrains|langchain|llama-?index|crewai|mcp-/.test(c))
    return { kind: 'assistant', label: 'AI assistant' };
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

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

// Patterns must match the regexes in tests/admin-stats.test.ts mockDb —
// keep the WHERE / GROUP BY clauses distinct enough that the test mock
// can identify each query unambiguously.
const SQL_ENDPOINTS = 'SELECT endpoint, COUNT(*) AS n FROM mcp_calls WHERE ts >= ? GROUP BY endpoint ORDER BY n DESC';
const SQL_DAILY = "SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS n FROM mcp_calls WHERE ts >= ? GROUP BY day ORDER BY day DESC";
// Per-day legitimate calculator calls, split by surface. Both filter
// is_error = 0 so probe/garbage traffic (calls that fail input validation
// before any calculator runs) is excluded — these count only calls that
// carried valid input and actually executed. REST and MCP tool calls are
// charted separately on the ops dashboard.
const SQL_DAILY_REST = "SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS n FROM mcp_calls WHERE endpoint LIKE 'rest:%' AND is_error = 0 AND ts >= ? GROUP BY day ORDER BY day DESC";
const SQL_DAILY_MCP = "SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS n FROM mcp_calls WHERE endpoint = 'mcp:tools/call' AND is_error = 0 AND ts >= ? GROUP BY day ORDER BY day DESC";
const SQL_TOOLS = 'SELECT tool, COUNT(*) AS n, SUM(is_error) AS errors FROM mcp_calls WHERE tool IS NOT NULL AND ts >= ? GROUP BY tool ORDER BY n DESC';
const SQL_ERRORS = 'SELECT endpoint, tool, error_msg, COUNT(*) AS n FROM mcp_calls WHERE is_error = 1 AND ts >= ? GROUP BY endpoint, tool, error_msg ORDER BY n DESC LIMIT 25';
// Clients come from MCP `initialize` handshakes, plus Poe requests (which have
// no handshake: each poe:* row carries client_name 'poe').
const SQL_CLIENTS = "SELECT client_name, COUNT(*) AS n FROM mcp_calls WHERE client_name IS NOT NULL AND (endpoint = 'mcp:initialize' OR endpoint LIKE 'poe:%') AND ts >= ? GROUP BY client_name ORDER BY n DESC";
const SQL_COUNTRIES = 'SELECT country, COUNT(*) AS n FROM mcp_calls WHERE ts >= ? GROUP BY country ORDER BY n DESC LIMIT 20';

async function q<T>(db: D1Database, sql: string, sinceMs: number): Promise<T[]> {
  const res = await db.prepare(sql).bind(sinceMs).all<T>();
  return res.results;
}

export const onRequest: PagesFunction = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const expected = env?.ADMIN_TOKEN;

  if (!expected) {
    return new Response('ADMIN_TOKEN not configured', { status: 503 });
  }
  if (!token || token !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  const db = env?.MCP_STATS;
  if (!db) {
    return new Response('MCP_STATS binding not configured', { status: 503 });
  }

  const daysParam = parseInt(url.searchParams.get('days') ?? '', 10);
  const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= MAX_DAYS ? daysParam : DEFAULT_DAYS;
  const sinceMs = Date.now() - days * 86_400_000;

  const [endpoints, daily, dailyRest, dailyMcp, tools, errors, clients, countries] = await Promise.all([
    q<EndpointRow>(db, SQL_ENDPOINTS, sinceMs),
    q<DayRow>(db, SQL_DAILY, sinceMs),
    q<DayRow>(db, SQL_DAILY_REST, sinceMs),
    q<DayRow>(db, SQL_DAILY_MCP, sinceMs),
    q<ToolRow>(db, SQL_TOOLS, sinceMs),
    q<ErrorRow>(db, SQL_ERRORS, sinceMs),
    q<ClientRow>(db, SQL_CLIENTS, sinceMs),
    q<CountryRow>(db, SQL_COUNTRIES, sinceMs),
  ]);

  // Optional ?errEndpoint=<exact endpoint>: the error_msg breakdown for one
  // endpoint, uncapped by the global top-25 (so low-volume diagnostics like
  // poe:extract-fail are visible behind the high-volume fuzzer noise).
  let endpointErrors: { error_msg: string; n: number }[] | undefined;
  const errEndpoint = url.searchParams.get('errEndpoint');
  if (errEndpoint) {
    const r = await db
      .prepare('SELECT error_msg, COUNT(*) AS n FROM mcp_calls WHERE endpoint = ? AND is_error = 1 AND ts >= ? GROUP BY error_msg ORDER BY n DESC LIMIT 25')
      .bind(errEndpoint, sinceMs)
      .all<{ error_msg: string; n: number }>();
    endpointErrors = r.results;
  }

  // Recent examples (real query+answer, 7-day rolling capture). Resilient: if
  // the mcp_samples table is not yet created (migration 0003 not applied) the
  // query throws and we show none. Optional ?surface=poe|mcp|rest filter.
  let samples: SampleRow[] = [];
  try {
    const surface = url.searchParams.get('surface');
    const sql = surface
      ? 'SELECT ts, surface, tool, client_name, query, answer FROM mcp_samples WHERE ts >= ? AND surface = ? ORDER BY ts DESC LIMIT 200'
      : 'SELECT ts, surface, tool, client_name, query, answer FROM mcp_samples WHERE ts >= ? ORDER BY ts DESC LIMIT 200';
    const stmt = surface ? db.prepare(sql).bind(sinceMs, surface) : db.prepare(sql).bind(sinceMs);
    samples = (await stmt.all<SampleRow>()).results;
  } catch {
    samples = [];
  }

  // Classify each captured example real-vs-bot, tally by kind, and (optionally)
  // filter the rendered list with ?kind=human,assistant (comma-separated).
  const surfaceParam = url.searchParams.get('surface');
  const kindFilter = (url.searchParams.get('kind') ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const classified: ClassifiedSample[] = samples.map((s) => ({ ...s, kind: classifyClient(s.client_name, s.surface).kind }));
  const sampleCounts: Partial<Record<ClientKind, number>> = {};
  for (const s of classified) sampleCounts[s.kind] = (sampleCounts[s.kind] ?? 0) + 1;
  const shownSamples = (kindFilter.length
    ? classified.filter((s) => kindFilter.includes(s.kind))
    : classified
  ).slice(0, 50);

  if (url.searchParams.get('format') === 'json') {
    const body = JSON.stringify({ days, endpoints, daily, dailyRest, dailyMcp, tools, errors, clients, countries, endpointErrors, samples: classified, sampleCounts });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const html = renderHtml({ days, endpoints, daily, dailyRest, dailyMcp, tools, errors, clients, countries, samples: shownSamples, sampleCounts, kindFilter, token, surface: surfaceParam });
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};

type ClassifiedSample = SampleRow & { kind: ClientKind };

interface RenderInput {
  days: number;
  endpoints: EndpointRow[];
  daily: DayRow[];
  dailyRest: DayRow[];
  dailyMcp: DayRow[];
  tools: ToolRow[];
  errors: ErrorRow[];
  clients: ClientRow[];
  countries: CountryRow[];
  samples: ClassifiedSample[];
  sampleCounts: Partial<Record<ClientKind, number>>;
  kindFilter: string[];
  token: string;
  surface: string | null;
}

const KIND_LABEL: Record<ClientKind, string> = {
  human: 'human',
  assistant: 'AI assistant',
  unknown: 'unknown',
  tool: 'script/tool',
  smoke: 'smoke test',
  crawler: 'crawler',
};

function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty">no data in window</p>';
  const thead = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const tbody = rows
    .map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>')
    .join('');
  return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

// Counts of captured examples by kind + one-click filters. Links carry the
// token + current window/surface so they work inside the ops iframe.
function samplesLegend(d: RenderInput): string {
  const href = (kind?: string) => {
    const p = new URLSearchParams();
    p.set('token', d.token);
    p.set('days', String(d.days));
    if (d.surface) p.set('surface', d.surface);
    if (kind) p.set('kind', kind);
    return esc('?' + p.toString());
  };
  const n = (k: ClientKind) => d.sampleCounts[k] ?? 0;
  const active = d.kindFilter.join(',');
  const link = (label: string, kind: string) =>
    `<a href="${href(kind || undefined)}"${active === kind ? ' style="font-weight:700"' : ''}>${esc(label)}</a>`;
  const counts =
    `real: <b>${n('human')}</b> human &middot; <b>${n('assistant')}</b> AI assistant` +
    ` &nbsp;|&nbsp; noise: <b>${n('smoke')}</b> smoke &middot; <b>${n('tool')}</b> tool &middot; ` +
    `<b>${n('crawler')}</b> crawler &middot; <b>${n('unknown')}</b> unknown`;
  const filters = [
    link('all', ''),
    link('real only', 'human,assistant'),
    link('human', 'human'),
    link('AI assistant', 'assistant'),
    link('script/tool', 'tool'),
    link('smoke', 'smoke'),
    link('crawler', 'crawler'),
  ].join(' ');
  return `<p class="legend">${counts}<br>filter: ${filters}<br><span style="color:#aaa">client is the MCP handshake name / Poe / a (spoofable) User-Agent. A heuristic, not proof</span></p>`;
}

function renderHtml(d: RenderInput): string {
  const total = d.endpoints.reduce((acc, r) => acc + r.n, 0);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MCP stats (${d.days}d)</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; max-width: 1000px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
  .meta { color: #888; font-size: 12px; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { padding: 4px 10px; border-bottom: 1px solid #eee; text-align: left; }
  th { font-weight: 600; color: #555; }
  td.num { text-align: right; }
  .empty { color: #aaa; font-style: italic; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  details.ex { border-bottom: 1px solid #eee; padding: 6px 0; }
  details.ex summary { cursor: pointer; color: #555; }
  details.ex summary .cl { color: #888; }
  details.ex pre { white-space: pre-wrap; word-break: break-word; background: #fafafa; padding: 8px; border-radius: 4px; font-size: 12px; overflow-x: auto; }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; vertical-align: middle; }
  .k-human    { background: #d8f3dc; color: #1b4332; }
  .k-assistant{ background: #d0ebff; color: #1864ab; }
  .k-unknown  { background: #f1f3f5; color: #495057; }
  .k-tool     { background: #fff3bf; color: #7d5a00; }
  .k-smoke    { background: #e9ecef; color: #868e96; }
  .k-crawler  { background: #ffe3e3; color: #c92a2a; }
  .legend { color: #888; font-size: 12px; margin: 4px 0 10px; }
  .legend a { color: #1864ab; text-decoration: none; margin-right: 8px; }
</style>
</head>
<body>
<h1>OptionsAhoy MCP stats</h1>
<p class="meta">Window: last ${d.days} days &middot; ${total.toLocaleString()} calls &middot; change with <code>?days=N</code></p>

<h2>By endpoint</h2>
${table(
  ['Endpoint', 'Calls'],
  d.endpoints.map((r) => [esc(r.endpoint), `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>By tool (errors in parens)</h2>
${table(
  ['Tool', 'Calls', 'Errors'],
  d.tools.map((r) => [esc(r.tool), `<span class="num">${r.n.toLocaleString()}</span>`, `<span class="num">${r.errors.toLocaleString()}</span>`]),
)}

<h2>By client (from initialize)</h2>
${table(
  ['Client', 'Connects'],
  d.clients.map((r) => [esc(r.client_name), `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>By day</h2>
${table(
  ['Day', 'Calls'],
  d.daily.map((r) => [esc(r.day), `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>By day (REST calls, valid input)</h2>
${table(
  ['Day', 'REST calls'],
  d.dailyRest.map((r) => [esc(r.day), `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>By day (MCP tool calls, valid input)</h2>
${table(
  ['Day', 'MCP tool calls'],
  d.dailyMcp.map((r) => [esc(r.day), `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>By country</h2>
${table(
  ['Country', 'Calls'],
  d.countries.map((r) => [esc(r.country) || '<i>n/a</i>', `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>Top errors (top 25)</h2>
${table(
  ['Endpoint', 'Tool', 'Error', 'Count'],
  d.errors.map((r) => [esc(r.endpoint), esc(r.tool) || '<i>-</i>', `<code>${esc(r.error_msg)}</code>`, `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>Recent examples (7-day capture)</h2>
${samplesLegend(d)}
${
  d.samples.length === 0
    ? '<p class="empty">no examples match (try a wider window, a different filter, or check migration 0003 is applied)</p>'
    : d.samples
        .map((s) => {
          const when = new Date(s.ts).toISOString().replace('T', ' ').slice(0, 16);
          const client = s.client_name ? esc(s.client_name) : '<i>unknown</i>';
          const badge = `<span class="badge k-${s.kind}">${esc(KIND_LABEL[s.kind])}</span>`;
          return `<details class="ex"><summary>${badge} ${esc(when)} &middot; <b>${esc(s.surface)}</b> &middot; ${esc(s.tool) || '<i>-</i>'} &middot; <span class="cl">${client}</span></summary><pre><b>Q:</b> ${esc(s.query)}\n\n<b>A:</b> ${esc(s.answer)}</pre></details>`;
        })
        .join('\n')
}

</body>
</html>`;
}
