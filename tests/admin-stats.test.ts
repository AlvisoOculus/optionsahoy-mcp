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

// Patterns must be mutually exclusive — find() picks the first match.
// `WHERE is_error = 1` is the errors query alone; the endpoints query is
// identified by its ORDER BY n DESC tail. The error-fields query ALSO carries
// `WHERE is_error = 1`, so its more-specific matcher must come first.
const SAMPLE_ROWS = [
  // Session funnel rollups: FROM mcp_sessions is the distinctive fragment
  // (their GROUP BY day tail would otherwise collide with the mcp_calls
  // daily matcher below, so these must come first).
  // Initializes grouped by client, windowed. Distinct from the endpoint
  // matcher below: this one names both mcp:initialize and client_name.
  { match: /endpoint = 'mcp:initialize' AND ts >= \? GROUP BY client_name/, rows: [
    { client_name: 'claude-code', n: 40 },   // human -> counts
    { client_name: 'langchain', n: 10 },     // agent -> counts
    { client_name: 'mcpregistry', n: 900 },  // crawler -> excluded
    { client_name: null, n: 55 },            // unnamed script -> excluded
  ] },
  { match: /FROM mcp_sessions[\s\S]*GROUP BY day/, rows: [{ day: '2026-08-03', n: 5, calls: 13 }] },
  { match: /FROM mcp_sessions[\s\S]*GROUP BY depth/, rows: [{ depth: 1, n: 3 }, { depth: 8, n: 1 }] },
  // error-fields (topErrorFields): shares 4+1=5, volatility 3; the smoke row is
  // dropped as infra, notARealField is dropped as not-an-input-field.
  { match: /GROUP BY error_msg, endpoint/, rows: [
    { error_msg: 'field "shares" required', endpoint: 'mcp:tools/call', client: null, n: 4 },
    { error_msg: 'field "shares" must be a whole number', endpoint: 'rest:amt', client: 'python-httpx/0.27', n: 1 },
    { error_msg: 'field "volatility" must be <= 5', endpoint: 'rest:concentration', client: 'Cursor', n: 3 },
    { error_msg: 'field "shares" required', endpoint: 'mcp:tools/call', client: 'optionsahoy-smoke', n: 100 },
    { error_msg: 'field "notARealField" required', endpoint: 'rest:x', client: null, n: 7 },
  ] },
  { match: /WHERE is_error = 1/, rows: [{ endpoint: 'mcp:tools/call', tool: 'amt_iso_optimize', error_msg: 'field "shares" required', n: 3 }] },
  { match: /WHERE tool IS NOT NULL/, rows: [{ tool: 'concentration_analyze', n: 18, errors: 2 }] },
  { match: /WHERE client_name IS NOT NULL/, rows: [{ client_name: 'Claude.ai', n: 5 }] },
  { match: /GROUP BY endpoint ORDER BY n DESC/, rows: [{ endpoint: 'mcp:tools/call', n: 42 }, { endpoint: 'mcp:initialize', n: 7 }] },
  // Must precede the generic /GROUP BY day/ — the two per-surface daily queries
  // also group by day, but are each uniquely identified by their endpoint filter.
  { match: /endpoint LIKE 'rest:%'/, rows: [{ day: '2026-05-27', n: 9 }, { day: '2026-05-26', n: 11 }] },
  { match: /endpoint = 'mcp:tools\/call'/, rows: [{ day: '2026-05-27', n: 3 }, { day: '2026-05-26', n: 4 }] },
  { match: /GROUP BY day/, rows: [{ day: '2026-05-27', n: 22 }, { day: '2026-05-26', n: 27 }] },
  { match: /SELECT country/, rows: [{ country: 'US', n: 30 }, { country: null, n: 5 }] },
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
        ...SAMPLE_ROWS.filter((r) => !/WHERE is_error/.test(r.match.source)),
        { match: /WHERE is_error/, rows: [{ endpoint: 'mcp:tools/call', tool: null, error_msg: '<script>alert(1)</script>', n: 1 }] },
      ]),
    };
    const res = await onRequest(ctx(env, req('?token=secret')));
    const html = await res.text();
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;alert/);
  });

  // Two captured examples with distinct real-vs-bot signals + geo/network.
  // The GROUP BY as_org matcher must precede SAMPLE_ROWS so the REST-network
  // rollup query resolves to it rather than the generic rest-daily matcher.
  const WITH_SAMPLES = [
    {
      match: /GROUP BY as_org/,
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
