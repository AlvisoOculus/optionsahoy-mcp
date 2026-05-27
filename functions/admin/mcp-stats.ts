// AlphaLatitude Inc. © 2026
//
// GET /admin/mcp-stats?token=<ADMIN_TOKEN>&days=<N>
//
// Token-gated dashboard for the MCP_STATS D1 table. Default 30-day window.
// Returns plain HTML tables — no JS, no auth flow, no cookies. Andrew is
// the only intended consumer; bookmark the URL with the token in the query
// string.
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

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

// Patterns must match the regexes in tests/admin-stats.test.ts mockDb —
// keep the WHERE / GROUP BY clauses distinct enough that the test mock
// can identify each query unambiguously.
const SQL_ENDPOINTS = 'SELECT endpoint, COUNT(*) AS n FROM mcp_calls WHERE ts >= ? GROUP BY endpoint ORDER BY n DESC';
const SQL_DAILY = "SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS n FROM mcp_calls WHERE ts >= ? GROUP BY day ORDER BY day DESC";
const SQL_TOOLS = 'SELECT tool, COUNT(*) AS n, SUM(is_error) AS errors FROM mcp_calls WHERE tool IS NOT NULL AND ts >= ? GROUP BY tool ORDER BY n DESC';
const SQL_ERRORS = 'SELECT endpoint, tool, error_msg, COUNT(*) AS n FROM mcp_calls WHERE is_error = 1 AND ts >= ? GROUP BY endpoint, tool, error_msg ORDER BY n DESC LIMIT 25';
const SQL_CLIENTS = "SELECT client_name, COUNT(*) AS n FROM mcp_calls WHERE client_name IS NOT NULL AND endpoint = 'mcp:initialize' AND ts >= ? GROUP BY client_name ORDER BY n DESC";
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

  const [endpoints, daily, tools, errors, clients, countries] = await Promise.all([
    q<EndpointRow>(db, SQL_ENDPOINTS, sinceMs),
    q<DayRow>(db, SQL_DAILY, sinceMs),
    q<ToolRow>(db, SQL_TOOLS, sinceMs),
    q<ErrorRow>(db, SQL_ERRORS, sinceMs),
    q<ClientRow>(db, SQL_CLIENTS, sinceMs),
    q<CountryRow>(db, SQL_COUNTRIES, sinceMs),
  ]);

  const html = renderHtml({ days, endpoints, daily, tools, errors, clients, countries });
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};

interface RenderInput {
  days: number;
  endpoints: EndpointRow[];
  daily: DayRow[];
  tools: ToolRow[];
  errors: ErrorRow[];
  clients: ClientRow[];
  countries: CountryRow[];
}

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

</body>
</html>`;
}
