// AlphaLatitude Inc. © 2026
//
// Unit tests for the public summary endpoint at /api/v1/stats. Uses a
// pattern-matched D1 mock to feed canned rows into the four queries the
// handler runs (total, since, top-tools, last-ts) and asserts shape +
// caching headers.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/api/v1/stats';
import type { D1Database, D1PreparedStatement, Env, PagesContext } from '../functions/_lib/stats';

function mockDb(): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let rows: unknown[] = [];
      if (/SELECT COUNT\(\*\) AS n FROM mcp_calls$/.test(sql)) rows = [{ n: 1234 }];
      else if (/WHERE ts >= \?/.test(sql)) rows = [{ n: 42 }];
      else if (/GROUP BY tool/.test(sql)) {
        rows = [
          { tool: 'amt_iso_optimize', n: 500 },
          { tool: 'concentration_analyze', n: 300 },
        ];
      } else if (/ORDER BY ts DESC LIMIT 1/.test(sql)) {
        rows = [{ ts: 1717718400000 }];
      }
      const stmt: D1PreparedStatement = {
        bind() {
          return stmt;
        },
        async run() {
          return undefined;
        },
        async all<T = unknown>() {
          return { results: rows as T[] };
        },
      };
      return stmt;
    },
  };
}

function ctx(env: Env): PagesContext {
  return {
    request: new Request('http://localhost/api/v1/stats', { method: 'GET' }),
    env,
  };
}

describe('GET /api/v1/stats', () => {
  it('returns 503 when MCP_STATS binding is missing', async () => {
    const res = await onRequest(ctx({}));
    expect(res.status).toBe(503);
  });

  it('returns a JSON summary with the expected fields', async () => {
    const res = await onRequest(ctx({ MCP_STATS: mockDb() }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.totalCalls).toBe(1234);
    expect(json.last24h).toBe(42);
    expect(json.last7d).toBe(42);
    expect(json.last30d).toBe(42);
    expect(json.topTools).toEqual([
      { name: 'amt_iso_optimize', count: 500 },
      { name: 'concentration_analyze', count: 300 },
    ]);
    expect(json.lastCallAt).toBe('2024-06-07T00:00:00.000Z');
    expect(json.asOf).toBeTypeOf('string');
  });

  it('returns 405 for non-GET, non-OPTIONS verbs', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/api/v1/stats', { method: 'POST' }),
      env: { MCP_STATS: mockDb() },
    });
    expect(res.status).toBe(405);
  });

  it('handles OPTIONS preflight with CORS headers and 204', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/api/v1/stats', { method: 'OPTIONS' }),
      env: { MCP_STATS: mockDb() },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
