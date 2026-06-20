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
// identified by its ORDER BY n DESC tail.
const SAMPLE_ROWS = [
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
});
