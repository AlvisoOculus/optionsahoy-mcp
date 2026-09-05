// AlphaLatitude Inc. © 2026
//
// Tests for the token-gated /admin/mcp-stats page. Mocks the D1 binding
// with canned query results and asserts auth + rendering.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/admin/mcp-stats';
import type { D1Database, D1PreparedStatement, Env, PagesContext } from '../functions/_lib/stats';

function mockDb(rowsByPattern: { match: RegExp; rows: unknown[] }[]): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      const hit = rowsByPattern.find((r) => r.match.test(sql));
      const rows = hit ? hit.rows : [];
      const obj: D1PreparedStatement = {
        bind() { return obj; },
        async run() { return undefined; },
        async all<T = unknown>() { return { results: rows as T[] }; },
      };
      return obj;
    },
  };
}

function req(qs: string): Request {
  return new Request(`http://localhost/admin/mcp-stats${qs}`, { method: 'GET' });
}

function ctx(env: Env, request: Request): PagesContext {
  return { request, env, waitUntil: () => undefined };
}

// Patterns must be mutually exclusive - find() picks the first match, so
// narrower matchers come first. Every panel now reads mcp_dim_daily
// (migration 0006) rather than scanning mcp_calls, so the matchers key off
// each read's `dim` and GROUP BY. Rows are the raw bucket columns where the
// read layer maps them (k1..k3), and the aliased shape where it does not.
//
// dim_snapshot is deliberately unmatched: ensureDimsFresh then finds no
// cursor and returns without folding, which is also the not-yet-migrated
// path these tests want.
const SAMPLE_ROWS = [
  { match: /FROM mcp_sessions[\s\S]*GROUP BY day/, rows: [{ day: '2026-08-03', n: 5, calls: 13 }] },
  { match: /FROM mcp_sessions[\s\S]*GROUP BY depth/, rows: [{ depth: 1, n: 3 }, { depth: 8, n: 1 }] },
  // Named clients (handshakes + Poe). Its SQL also names mcp:initialize, so
  // this narrower "k1 != ''" matcher must precede the init-clients one.
  { match: /dim = 'client'[\s\S]*k1 != ''/, rows: [{ client_name: 'Claude.ai', n: 5 }] },
  // Initializes grouped by client (k1), named or not: the funnel classifies
  // these itself, so the unnamed probe bucket must survive the read layer.
  { match: /dim = 'client'[\s\S]*k2 = 'mcp:initialize'/, rows: [
    { k1: 'claude-code', n: 40 },   // human -> counts
    { k1: 'langchain', n: 10 },     // agent -> counts
    { k1: 'mcpregistry', n: 900 },  // crawler -> excluded
    { k1: '', n: 55 },              // unnamed script -> excluded
  ] },
  // error-fields (topErrorFields): shares 4+1=5, volatility 3; the smoke row is
  // dropped as infra, notARealField is dropped as not-an-input-field.
  { match: /dim = 'errfield'/, rows: [
    { k1: 'field "shares" required', k2: 'mcp:tools/call', k3: '', n: 4 },
    { k1: 'field "shares" must be a whole number', k2: 'rest:amt', k3: 'python-httpx/0.27', n: 1 },
    { k1: 'field "volatility" must be <= 5', k2: 'rest:concentration', k3: 'Cursor', n: 3 },
    { k1: 'field "shares" required', k2: 'mcp:tools/call', k3: 'optionsahoy-smoke', n: 100 },
    { k1: 'field "notARealField" required', k2: 'rest:x', k3: '', n: 7 },
  ] },
  { match: /dim = 'error'/, rows: [{ k1: 'mcp:tools/call', k2: 'amt_iso_optimize', k3: 'field "shares" required', n: 3 }] },
  // The two per-surface daily reads also carry dim = 'endpoint', so their
  // endpoint filters must be matched before the generic endpoint reads.
  { match: /k1 LIKE 'rest:%'/, rows: [{ day: '2026-05-27', n: 9 }, { day: '2026-05-26', n: 11 }] },
  { match: /k1 = 'mcp:tools\/call'/, rows: [{ day: '2026-05-27', n: 3 }, { day: '2026-05-26', n: 4 }] },
  { match: /dim = 'endpoint'[\s\S]*GROUP BY k1/, rows: [{ endpoint: 'mcp:tools/call', n: 42 }, { endpoint: 'mcp:initialize', n: 7 }] },
  { match: /dim = 'endpoint'[\s\S]*GROUP BY day/, rows: [{ day: '2026-05-27', n: 22 }, { day: '2026-05-26', n: 27 }] },
  { match: /dim = 'tool'/, rows: [{ tool: 'concentration_analyze', n: 18, errors: 2 }] },
  { match: /dim = 'country'/, rows: [{ k1: 'US', n: 30 }, { k1: '', n: 5 }] },
];

describe('admin /mcp-stats', () => {
  it('returns 503 when ADMIN_TOKEN is not configured', async () => {
    const res = await onRequest(ctx({}, req('?token=anything')));
    expect(res.status).toBe(503);
  });

  it('returns 401 when token query param is missing', async () => {
    const res = await onRequest(ctx({ ADMIN_TOKEN: 'secret' }, req('')));
    expect(res.status).toBe(401);
  });

  it('returns 401 when token does not match', async () => {
    const res = await onRequest(ctx({ ADMIN_TOKEN: 'secret' }, req('?token=wrong')));
    expect(res.status).toBe(401);
  });

  it('returns 503 when MCP_STATS binding is missing', async () => {
    const res = await onRequest(ctx({ ADMIN_TOKEN: 'secret' }, req('?token=secret')));
    expect(res.status).toBe(503);
  });

  it('renders an HTML page with all sections when authorized', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(SAMPLE_ROWS) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7')));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/OptionsAhoy MCP stats/);
    expect(html).toMatch(/last 7 days/);
    expect(html).toMatch(/mcp:tools\/call/);
    expect(html).toMatch(/concentration_analyze/);
    expect(html).toMatch(/Claude\.ai/);
    expect(html).toMatch(/field &quot;shares&quot; required/);
    expect(html).toMatch(/2026-05-27/);
    expect(html).toMatch(/REST calls, valid input/);
    expect(html).toMatch(/MCP tool calls, valid input/);
    expect(html).toMatch(/Most-omitted input fields/);
  });

  it('returns structured JSON when format=json', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(SAMPLE_ROWS) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7&format=json')));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.days).toBe(7);
    expect(body.endpoints).toEqual([
      { endpoint: 'mcp:tools/call', n: 42 },
      { endpoint: 'mcp:initialize', n: 7 },
    ]);
    expect(body.tools[0].tool).toBe('concentration_analyze');
    expect(body.clients[0].client_name).toBe('Claude.ai');
    expect(body.daily.length).toBe(2);
    expect(body.dailyRest).toEqual([
      { day: '2026-05-27', n: 9 },
      { day: '2026-05-26', n: 11 },
    ]);
    expect(body.dailyMcp).toEqual([
      { day: '2026-05-27', n: 3 },
      { day: '2026-05-26', n: 4 },
    ]);
    // Infra (smoke) excluded and non-schema field names dropped; shares 4+1.
    expect(body.topErrorFields).toEqual([
      { field: 'shares', count: 5 },
      { field: 'volatility', count: 3 },
    ]);
  });

  it('still requires the token when format=json', async () => {
    const res = await onRequest(ctx({ ADMIN_TOKEN: 'secret' }, req('?format=json')));
    expect(res.status).toBe(401);
  });

  it('clamps absurd day values to the default window', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(SAMPLE_ROWS) };
    const res = await onRequest(ctx(env, req('?token=secret&days=999999')));
    const html = await res.text();
    expect(html).toMatch(/last 30 days/);
  });

  it('escapes HTML in error messages to prevent script injection', async () => {
    const env: Env = {
      ADMIN_TOKEN: 'secret',
      MCP_STATS: mockDb([
        ...SAMPLE_ROWS.filter((r) => !/dim = 'error'/.test(r.match.source)),
        { match: /dim = 'error'/, rows: [{ k1: 'mcp:tools/call', k2: '', k3: '<script>alert(1)</script>', n: 1 }] },
      ]),
    };
    const res = await onRequest(ctx(env, req('?token=secret')));
    const html = await res.text();
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;alert/);
  });

  // Two captured examples with distinct real-vs-bot signals + geo/network.
  // The restnet matcher must precede SAMPLE_ROWS so the REST-network panel
  // resolves to it rather than to the generic rest-daily matcher.
  const WITH_SAMPLES = [
    {
      match: /dim = 'restnet'/,
      rows: [
        { as_org: 'Amazon.com, Inc.', city: 'Ashburn', region: 'Virginia', country: 'US', n: 7 },
        { as_org: 'Comcast Cable', city: 'San Jose', region: 'California', country: 'US', n: 2 },
      ],
    },
    ...SAMPLE_ROWS,
    {
      match: /FROM mcp_samples/,
      rows: [
        // MCP from Anthropic's cloud: geo must be suppressed (city is unique so
        // we can assert it never renders).
        { ts: 1_750_000_000_000, surface: 'mcp', tool: 'amt_iso_optimize', client_name: 'Claude-User', query: '{"shares":10000}', answer: '{"ok":true}', country: 'US', region: 'Virginia', city: 'Quantico', as_org: 'Amazon', asn: 16509 },
        // Direct REST from a datacenter: gets a datacenter badge + location.
        { ts: 1_749_999_000_000, surface: 'rest', tool: 'qsbs_check', client_name: 'OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)', query: '{"x":1}', answer: '{"ok":true}', country: 'US', region: 'Oregon', city: 'Boardman', as_org: 'Amazon.com, Inc.', asn: 16509 },
      ],
    },
  ];

  it('classifies captured examples and renders a badge per row', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(WITH_SAMPLES) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7')));
    const html = await res.text();
    // Claude-User is a person driving Claude, so it reads as human.
    expect(html).toMatch(/class="badge k-human"/);
    expect(html).toMatch(/class="badge k-smoke"/);
    // Counts line distinguishes real from noise.
    expect(html).toMatch(/<b>1<\/b> human/);
    expect(html).toMatch(/<b>1<\/b> smoke/);
    // One-click "real only" filter that preserves the token.
    expect(html).toMatch(/kind=human%2Cagent/);
  });

  it('?kind= filters the rendered examples to the chosen bucket', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(WITH_SAMPLES) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7&kind=human,agent')));
    const html = await res.text();
    expect(html).toMatch(/class="badge k-human"/);
    expect(html).not.toMatch(/class="badge k-smoke"/);
  });

  it('format=json annotates each sample with its kind plus a sampleCounts tally', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(WITH_SAMPLES) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7&format=json')));
    const body = await res.json();
    expect(body.samples.map((s: { kind: string }) => s.kind)).toEqual(['human', 'smoke']);
    expect(body.sampleCounts).toMatchObject({ human: 1, smoke: 1 });
  });

  it('renders the REST callers network+location rollup with datacenter/residential badges', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(WITH_SAMPLES) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7')));
    const html = await res.text();
    expect(html).toMatch(/REST callers \(network/);
    expect(html).toMatch(/class="badge net-hosting">datacenter/);
    expect(html).toMatch(/class="badge net-residential">residential/);
    expect(html).toMatch(/Ashburn/);
  });

  it('shows location + datacenter on a direct REST example, suppresses geo on MCP', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(WITH_SAMPLES) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7&surface=rest')));
    const html = await res.text();
    // REST example shows its town and a datacenter network badge.
    expect(html).toMatch(/Boardman/);
    // MCP example's geo (its unique town) is never rendered: cloud origin is
    // the assistant's, not the user's.
    const all = await (await onRequest(ctx(env, req('?token=secret&days=7')))).text();
    expect(all).not.toMatch(/Quantico/);
  });

  it('format=json marks sample network per surface (mcp blind, rest classified)', async () => {
    const env: Env = { ADMIN_TOKEN: 'secret', MCP_STATS: mockDb(WITH_SAMPLES) };
    const res = await onRequest(ctx(env, req('?token=secret&days=7&format=json')));
    const body = await res.json();
    expect(body.samples.map((s: { network: string }) => s.network)).toEqual(['unknown', 'hosting']);
    expect(body.restNet).toHaveLength(2);
  });
});

describe('admin /mcp-stats auth accepts a Bearer header (machine callers)', () => {
  it('authorizes with Authorization: Bearer, so the token need not ride in the URL', async () => {
    const request = new Request('http://localhost/admin/mcp-stats?days=7', {
      method: 'GET',
      headers: { authorization: 'Bearer right' },
    });
    const res = await onRequest(ctx({ ADMIN_TOKEN: 'right', MCP_STATS: mockDb(SAMPLE_ROWS) }, request));
    expect(res.status).toBe(200);
  });

  it('still rejects a wrong Bearer token', async () => {
    const request = new Request('http://localhost/admin/mcp-stats', {
      method: 'GET',
      headers: { authorization: 'Bearer nope' },
    });
    const res = await onRequest(ctx({ ADMIN_TOKEN: 'right', MCP_STATS: mockDb(SAMPLE_ROWS) }, request));
    expect(res.status).toBe(401);
  });
});

describe('initializesReal (funnel top-of-pipeline, probes excluded)', () => {
  it('counts only human/agent clients, over the requested window', async () => {
    const res = await onRequest(
      ctx({ ADMIN_TOKEN: 'right', MCP_STATS: mockDb(SAMPLE_ROWS) }, req('?token=right&days=7&format=json')),
    );
    const json = (await res.json()) as { initializesReal: number };
    // 40 (claude-code, human) + 10 (langchain, agent). The 900 crawler and
    // the 55 unnamed-script initializes are excluded.
    expect(json.initializesReal).toBe(50);
  });
});

describe('Bearer parsing edge cases', () => {
  const env = () => ({ ADMIN_TOKEN: 'right', MCP_STATS: mockDb(SAMPLE_ROWS) });
  const withAuth = (auth: string, qs = '') =>
    new Request(`http://localhost/admin/mcp-stats${qs}`, { method: 'GET', headers: { authorization: auth } });

  it('accepts a lowercase scheme (RFC 7235: case-insensitive)', async () => {
    expect((await onRequest(ctx(env(), withAuth('bearer right')))).status).toBe(200);
  });

  it('a malformed header does not shadow a valid ?token=', async () => {
    expect((await onRequest(ctx(env(), withAuth('Bearer ', '?token=right')))).status).toBe(200);
    expect((await onRequest(ctx(env(), withAuth('Basic abc', '?token=right')))).status).toBe(200);
  });

  it('an empty or unset ADMIN_TOKEN can never be matched', async () => {
    const res = await onRequest(ctx({ ADMIN_TOKEN: '', MCP_STATS: mockDb(SAMPLE_ROWS) }, withAuth('Bearer ')));
    expect(res.status).toBe(503);
  });
});
