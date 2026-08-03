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
//
// ADMIN_TOKEN must be stored as a Pages SECRET (secret_text), never as a
// plain-text variable: plain variables are readable in the dashboard and are
// returned in full by the Pages API to anyone with account read access, while
// secrets are write-only. This drifted once (found 2026-08-02, rotated), so
// re-check the type after any change to the project's variables.
//
// Two things to know when rotating it. Pages Functions read the environment
// snapshot bound to their DEPLOYMENT, so a changed variable does nothing until
// a NEW deployment is built - retrying an existing one replays the old
// snapshot, and the previous token keeps working until then. And `main` here
// is protected, so that new deployment comes from a merged PR rather than a
// direct push. Full runbook: optionsahoy_ops docs/ops/optionsahoy-mcp-deploy.md.

import { type PagesFunction } from '../_lib/api';
import { type D1Database } from '../_lib/stats';
import { classifyClient, isInfraClient, KIND_RANK, type ClientKind } from '../_lib/classify';
import { rankErrorFields } from '../_lib/error-fields';

// Client classification lives in ../_lib/classify (shared with the sample
// capture). Re-exported here so existing consumers/tests that import from this
// route keep working.
export { classifyClient, KIND_RANK, type ClientKind };

interface EndpointRow { endpoint: string; n: number; errors: number }
interface DayRow { day: string; n: number }
interface ToolRow { tool: string; n: number; errors: number }
interface ErrorRow { endpoint: string; tool: string | null; error_msg: string; n: number }
interface ClientRow { client_name: string; n: number }
interface InitClientRow { client_name: string | null; n: number }
interface CountryRow { country: string | null; n: number }
interface ErrFieldRow { error_msg: string; endpoint: string; client: string | null; n: number }
interface SampleRow { ts: number; surface: string; tool: string | null; client_name: string | null; query: string | null; answer: string | null; country: string | null; region: string | null; city: string | null; as_org: string | null; asn: number | null }
interface RestNetRow { as_org: string; city: string; region: string; country: string; n: number }
interface SessionDayRow { day: string; n: number; calls: number }
interface SessionDepthRow { depth: number; n: number }

// --- originating-network classification (the primary bot signal) ------------
//
// Matches the AS organization name against known cloud/hosting networks vs
// consumer ISPs. A direct REST caller from a hosting network is almost
// certainly automation; a real person comes from a consumer ISP. Conservative:
// only a positive hosting match flags a datacenter, so an unmatched org stays
// 'unknown' rather than being assumed human. NOTE: this only discriminates on
// the REST/direct surface. MCP calls from a real user originate from the
// assistant's cloud, so cloud origin is EXPECTED there and is not a bot tell.
export type NetworkKind = 'hosting' | 'residential' | 'unknown';

const HOSTING_RE = /amazon|aws|\bec2\b|google|gcp|microsoft|azure|oracle|ovh|hetzner|digital\s?ocean|linode|akamai|fastly|cloudflare|vultr|choopa|constant company|scaleway|contabo|leaseweb|m247|stackpath|limelight|datacamp|tencent|alibaba|aliyun|huawei|kamatera|upcloud|gcore|hosting|data\s?cent(?:er|re)|colo(?:cation)?|\bvps\b|servers\.com/i;
const RESIDENTIAL_RE = /comcast|xfinity|verizon|at&t|t-?mobile|sprint|charter|spectrum|cox\b|centurylink|lumen|frontier|cable|broadband|telecom|wireless|fios|vodafone|deutsche telekom|orange|telefonica|movistar|bell canada|rogers|shaw|telus|virgin media|\bjio\b|airtel/i;

export function networkKind(asOrg: string | null | undefined): NetworkKind {
  const s = (asOrg ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (HOSTING_RE.test(s)) return 'hosting';
  if (RESIDENTIAL_RE.test(s)) return 'residential';
  return 'unknown';
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

// Patterns must match the regexes in tests/admin-stats.test.ts mockDb —
// keep the WHERE / GROUP BY clauses distinct enough that the test mock
// can identify each query unambiguously.
const SQL_ENDPOINTS = 'SELECT endpoint, COUNT(*) AS n, SUM(is_error) AS errors FROM mcp_calls WHERE ts >= ? GROUP BY endpoint ORDER BY n DESC';
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
// Input-friction signal: which required fields callers most often omit or botch,
// over the agent-facing calculator-call surfaces (mcp:tools/call + REST). Poe is
// excluded by design: its bot pre-fills inputs, so a Poe error is an extraction
// failure, not caller input-friction. Carries client + endpoint so infra noise
// can be dropped in JS. `client` is COALESCE(client_name, ua): tool-call rows
// carry no handshake client_name (that is only on mcp:initialize), so on the MCP
// surface exclusion relies on the UA. REST smoke sets a marker UA and IS dropped;
// the MCP smoke sends no marker on call rows, so its exclusion is best-effort
// (harmless today: it sends valid inputs, so it generates no field errors).
// GROUP BY error_msg, endpoint, client keeps this shape distinct from SQL_ERRORS
// for the test mock's matcher.
const SQL_ERR_FIELDS = "SELECT error_msg, endpoint, COALESCE(client_name, ua) AS client, COUNT(*) AS n FROM mcp_calls WHERE is_error = 1 AND (endpoint = 'mcp:tools/call' OR endpoint LIKE 'rest:%') AND ts >= ? GROUP BY error_msg, endpoint, client";
// Clients come from MCP `initialize` handshakes, plus Poe requests (which have
// no handshake: each poe:* row carries client_name 'poe').
const SQL_CLIENTS = "SELECT client_name, COUNT(*) AS n FROM mcp_calls WHERE client_name IS NOT NULL AND (endpoint = 'mcp:initialize' OR endpoint LIKE 'poe:%') AND ts >= ? GROUP BY client_name ORDER BY n DESC";
// Initializes grouped by the client's self-reported name, so the funnel can
// separate real connects from the registry-probe swarm (~80% of handshakes)
// using this repo's own classifier rather than a re-invented regex elsewhere.
const SQL_INIT_CLIENTS = "SELECT client_name, COUNT(*) AS n FROM mcp_calls WHERE endpoint = 'mcp:initialize' GROUP BY client_name";
const SQL_COUNTRIES = 'SELECT country, COUNT(*) AS n FROM mcp_calls WHERE ts >= ? GROUP BY country ORDER BY n DESC LIMIT 20';
// REST/direct callers by originating network + coarse location. This is where
// the datacenter-vs-residential bot signal is meaningful (MCP is excluded: its
// cloud origin is expected and says nothing about bot-ness).
// Funnel: sessions per day (id issued at initialize, echoed by compliant
// clients, one row per session that made at least one tools/call) plus the
// call-depth histogram. first_seen is an ISO string column, so these bind an
// ISO timestamp rather than the ms epoch the mcp_calls queries use. Only
// meaningful after 2026-08-03 (before the session-id fix the server never
// issued ids and this table had 9 rows ever).
// e2e smoke runs supply their own session ids with this prefix
// (scripts/e2e-live.mjs) and would otherwise read as organic sessions in the
// funnel rollups. ONE artifact: every mcp_sessions query interpolates
// SMOKE_SESSION_FILTER rather than restating the literal.
export const E2E_SESSION_PREFIX = 'e2e-';
const SMOKE_SESSION_FILTER = `session_id NOT LIKE '${E2E_SESSION_PREFIX}%'`;
const SQL_SESSIONS_DAILY = `SELECT date(first_seen) AS day, COUNT(*) AS n, SUM(tool_call_count) AS calls FROM mcp_sessions WHERE ${SMOKE_SESSION_FILTER} AND first_seen >= ? GROUP BY day ORDER BY day DESC`;
const SQL_SESSION_DEPTH = `SELECT tool_call_count AS depth, COUNT(*) AS n FROM mcp_sessions WHERE ${SMOKE_SESSION_FILTER} AND first_seen >= ? GROUP BY depth ORDER BY depth`;
const SQL_REST_NET = "SELECT COALESCE(as_org, '(unknown)') AS as_org, COALESCE(city, '') AS city, COALESCE(region, '') AS region, COALESCE(country, '') AS country, COUNT(*) AS n FROM mcp_calls WHERE endpoint LIKE 'rest:%' AND ts >= ? GROUP BY as_org, city, region, country ORDER BY n DESC LIMIT 40";

// `since` is ms epoch for mcp_calls (integer ts column) and an ISO string
// for mcp_sessions (text first_seen column).
async function q<T>(db: D1Database, sql: string, since: number | string): Promise<T[]> {
  const res = await db.prepare(sql).bind(since).all<T>();
  return res.results;
}

// Degrade to empty ONLY for the not-yet-migrated case; anything else (typo'd
// column, real D1 failure) still throws so drift cannot hide as "no data".
function emptyIfUnmigrated(e: unknown): never[] {
  if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return [];
  throw e;
}

export const onRequest: PagesFunction = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  // Accept the token as a Bearer header as well as the ?token= query param.
  // The query form stays for the bookmarkable browser view; machine callers
  // (the web project's /admin/funnel) use the header so the secret does not
  // land in this project's request logs or ride through redirects.
  const auth = request.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  const token = bearer ?? url.searchParams.get('token');
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

  const [endpoints, daily, dailyRest, dailyMcp, tools, errors, clients, countries, restNet, errFieldRaw, sessionsDaily, sessionDepth, initClients] = await Promise.all([
    q<EndpointRow>(db, SQL_ENDPOINTS, sinceMs),
    q<DayRow>(db, SQL_DAILY, sinceMs),
    q<DayRow>(db, SQL_DAILY_REST, sinceMs),
    q<DayRow>(db, SQL_DAILY_MCP, sinceMs),
    q<ToolRow>(db, SQL_TOOLS, sinceMs),
    q<ErrorRow>(db, SQL_ERRORS, sinceMs),
    q<ClientRow>(db, SQL_CLIENTS, sinceMs),
    q<CountryRow>(db, SQL_COUNTRIES, sinceMs),
    // Resilient: pre-0004 databases lack as_org/region/city, so this throws
    // until the migration is applied. Degrade to an empty rollup, not a 500.
    q<RestNetRow>(db, SQL_REST_NET, sinceMs).catch(() => [] as RestNetRow[]),
    q<ErrFieldRow>(db, SQL_ERR_FIELDS, sinceMs),
    q<SessionDayRow>(db, SQL_SESSIONS_DAILY, new Date(sinceMs).toISOString()).catch(emptyIfUnmigrated),
    q<SessionDepthRow>(db, SQL_SESSION_DEPTH, new Date(sinceMs).toISOString()).catch(emptyIfUnmigrated),
    q<InitClientRow>(db, SQL_INIT_CLIENTS, sinceMs),
  ]);

  // A real connect = a person in an AI client, or a programmatic agent
  // framework. Crawlers, scanners, our own smoke, bare scripts and unnamed
  // callers are not. Same classifier as the example capture, so "real" means
  // one thing across the whole dashboard.
  const initializesReal = initClients
    .filter((r) => {
      const kind = classifyClient(r.client_name, 'mcp').kind;
      return kind === 'human' || kind === 'agent';
    })
    .reduce((acc, r) => acc + r.n, 0);

  // Rank the fields callers most often omit or botch, dropping infrastructure
  // noise (our smoke suite + scanners) where the client is identifiable (see
  // SQL_ERR_FIELDS). rankErrorFields keeps only real tool-input field names, so
  // garbage field names never appear.
  const topErrorFields = rankErrorFields(
    errFieldRaw
      .filter((r) => !isInfraClient(r.client, r.endpoint.startsWith('mcp:') ? 'mcp' : 'rest'))
      .map((r) => ({ errorMsg: r.error_msg, n: r.n })),
  );

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
    const cols = 'ts, surface, tool, client_name, query, answer, country, region, city, as_org, asn';
    const sql = surface
      ? `SELECT ${cols} FROM mcp_samples WHERE ts >= ? AND surface = ? ORDER BY ts DESC LIMIT 200`
      : `SELECT ${cols} FROM mcp_samples WHERE ts >= ? ORDER BY ts DESC LIMIT 200`;
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
  const classified: ClassifiedSample[] = samples.map((s) => ({
    ...s,
    kind: classifyClient(s.client_name, s.surface).kind,
    // Network is only a meaningful signal on direct (non-MCP) surfaces.
    network: s.surface === 'mcp' ? 'unknown' : networkKind(s.as_org),
  }));
  const sampleCounts: Partial<Record<ClientKind, number>> = {};
  for (const s of classified) sampleCounts[s.kind] = (sampleCounts[s.kind] ?? 0) + 1;
  const shownSamples = (kindFilter.length
    ? classified.filter((s) => kindFilter.includes(s.kind))
    : classified
  ).slice(0, 50);

  if (url.searchParams.get('format') === 'json') {
    const body = JSON.stringify({ days, endpoints, daily, dailyRest, dailyMcp, tools, errors, topErrorFields, clients, countries, restNet, sessionsDaily, sessionDepth, initializesReal, endpointErrors, samples: classified, sampleCounts });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const html = renderHtml({ days, endpoints, daily, dailyRest, dailyMcp, tools, errors, topErrorFields, clients, countries, restNet, sessionsDaily, sessionDepth, initializesReal, samples: shownSamples, sampleCounts, kindFilter, token, surface: surfaceParam });
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};

type ClassifiedSample = SampleRow & { kind: ClientKind; network: NetworkKind };

interface RenderInput {
  days: number;
  endpoints: EndpointRow[];
  daily: DayRow[];
  dailyRest: DayRow[];
  dailyMcp: DayRow[];
  tools: ToolRow[];
  errors: ErrorRow[];
  topErrorFields: { field: string; count: number }[];
  clients: ClientRow[];
  countries: CountryRow[];
  restNet: RestNetRow[];
  sessionsDaily: SessionDayRow[];
  sessionDepth: SessionDepthRow[];
  initializesReal: number;
  samples: ClassifiedSample[];
  sampleCounts: Partial<Record<ClientKind, number>>;
  kindFilter: string[];
  token: string;
  surface: string | null;
}

const KIND_LABEL: Record<ClientKind, string> = {
  human: 'human',
  agent: 'AI agent',
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
    `real: <b>${n('human')}</b> human &middot; <b>${n('agent')}</b> AI agent` +
    ` &nbsp;|&nbsp; noise: <b>${n('smoke')}</b> smoke &middot; <b>${n('tool')}</b> tool &middot; ` +
    `<b>${n('crawler')}</b> crawler &middot; <b>${n('unknown')}</b> unknown`;
  const filters = [
    link('all', ''),
    link('real only', 'human,agent'),
    link('human', 'human'),
    link('AI agent', 'agent'),
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
  .k-agent    { background: #d0ebff; color: #1864ab; }
  .k-unknown  { background: #f1f3f5; color: #495057; }
  .k-tool     { background: #fff3bf; color: #7d5a00; }
  .k-smoke    { background: #e9ecef; color: #868e96; }
  .k-crawler  { background: #ffe3e3; color: #c92a2a; }
  .net-hosting     { background: #ffe3e3; color: #c92a2a; }
  .net-residential { background: #d8f3dc; color: #1b4332; }
  .geo { color: #999; font-size: 11px; }
  .legend { color: #888; font-size: 12px; margin: 4px 0 10px; }
  .legend a { color: #1864ab; text-decoration: none; margin-right: 8px; }
</style>
</head>
<body>
<h1>OptionsAhoy MCP stats</h1>
<p class="meta">Window: last ${d.days} days &middot; ${total.toLocaleString()} calls &middot; change with <code>?days=N</code></p>

<h2>By endpoint</h2>
${table(
  ['Endpoint', 'Calls', 'Errors'],
  d.endpoints.map((r) => [esc(r.endpoint), `<span class="num">${r.n.toLocaleString()}</span>`, `<span class="num">${(r.errors ?? 0).toLocaleString()}</span>`]),
)}

<h2>By tool (errors in parens)</h2>
${table(
  ['Tool', 'Calls', 'Errors'],
  d.tools.map((r) => [esc(r.tool), `<span class="num">${r.n.toLocaleString()}</span>`, `<span class="num">${r.errors.toLocaleString()}</span>`]),
)}

<h2>Real connects (initialize, crawlers/scanners/scripts excluded)</h2>
<p class="legend">Classifier kinds human + agent only. The raw initialize count in the endpoint table is dominated by registry probes and is not an adoption number.</p>
<p><b>${d.initializesReal.toLocaleString()}</b></p>

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

<h2>Sessions (funnel: id echoed + made a tools/call)</h2>
${table(
  ['Day', 'Sessions', 'Tool calls'],
  d.sessionsDaily.map((r) => [esc(r.day), `<span class="num">${r.n.toLocaleString()}</span>`, `<span class="num">${r.calls.toLocaleString()}</span>`]),
)}

<h2>Session call depth</h2>
${table(
  ['Calls in session', 'Sessions'],
  d.sessionDepth.map((r) => [`<span class="num">${r.depth}</span>`, `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>By country</h2>
${table(
  ['Country', 'Calls'],
  d.countries.map((r) => [esc(r.country) || '<i>n/a</i>', `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>REST callers (network + location)</h2>
<p class="legend">Direct REST callers by originating network and city. On this surface a datacenter network is almost certainly a bot; a consumer ISP is likely a person. MCP is excluded (its cloud origin is expected and is not a bot tell). Needs migration 0004.</p>
${table(
  ['Network', 'Location', 'Calls'],
  d.restNet.map((r) => {
    const nk = networkKind(r.as_org);
    const badge = nk === 'hosting'
      ? '<span class="badge net-hosting">datacenter</span> '
      : nk === 'residential'
        ? '<span class="badge net-residential">residential</span> '
        : '';
    const loc = [r.city, r.region, r.country].filter(Boolean).join(', ');
    return [`${badge}${esc(r.as_org)}`, esc(loc) || '<i>n/a</i>', `<span class="num">${r.n.toLocaleString()}</span>`];
  }),
)}

<h2>Top errors (top 25)</h2>
${table(
  ['Endpoint', 'Tool', 'Error', 'Count'],
  d.errors.map((r) => [esc(r.endpoint), esc(r.tool) || '<i>-</i>', `<code>${esc(r.error_msg)}</code>`, `<span class="num">${r.n.toLocaleString()}</span>`]),
)}

<h2>Most-omitted input fields (calc calls, infra excluded)</h2>
${table(
  ['Field', 'Errors'],
  d.topErrorFields.map((r) => [`<code>${esc(r.field)}</code>`, `<span class="num">${r.count.toLocaleString()}</span>`]),
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
          const netBadge = s.network === 'hosting'
            ? ' <span class="badge net-hosting">datacenter</span>'
            : s.network === 'residential'
              ? ' <span class="badge net-residential">residential</span>'
              : '';
          // Location is only shown for direct surfaces; an MCP row's geo is the
          // assistant's cloud, not the user's, so it would mislead.
          const loc = s.surface !== 'mcp' ? [s.city, s.region, s.country].filter(Boolean).join(', ') : '';
          const geo = loc ? ` <span class="geo">${esc(loc)}${s.as_org ? ' &middot; ' + esc(s.as_org) : ''}</span>` : '';
          return `<details class="ex"><summary>${badge}${netBadge} ${esc(when)} &middot; <b>${esc(s.surface)}</b> &middot; ${esc(s.tool) || '<i>-</i>'} &middot; <span class="cl">${client}</span>${geo}</summary><pre><b>Q:</b> ${esc(s.query)}\n\n<b>A:</b> ${esc(s.answer)}</pre></details>`;
        })
        .join('\n')
}

</body>
</html>`;
}
