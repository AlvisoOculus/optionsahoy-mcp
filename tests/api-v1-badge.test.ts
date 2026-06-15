// AlphaLatitude Inc. © 2026
//
// Unit tests for the shields.io endpoint-badge source at /api/v1/badge.
// Asserts the schemaVersion-1 shape, metric selection, number humanization,
// and the always-200 fallbacks (missing binding, unknown metric) that keep
// the badge rendering instead of showing shields' error state.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/api/v1/badge';
import type { D1Database, D1PreparedStatement, Env, PagesContext } from '../functions/_lib/stats';

function mockDb(n: number): D1Database {
  return {
    prepare(): D1PreparedStatement {
      const stmt: D1PreparedStatement = {
        bind() {
          return stmt;
        },
        async run() {
          return undefined;
        },
        async all<T = unknown>() {
          return { results: [{ n }] as T[] };
        },
      };
      return stmt;
    },
  };
}

function ctx(url: string, env: Env): PagesContext {
  return { request: new Request(url, { method: 'GET' }), env };
}

describe('GET /api/v1/badge', () => {
  it('defaults to the calls30d metric with shields schema', async () => {
    const res = await onRequest(ctx('http://localhost/api/v1/badge', { MCP_STATS: mockDb(8793) }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.schemaVersion).toBe(1);
    expect(json.label).toBe('MCP calls (30d)');
    expect(json.message).toBe('8.8k');
    expect(json.color).toBe('blue');
  });

  it('humanizes thousands and millions, leaves small numbers intact', async () => {
    const small = (await (await onRequest(ctx('http://localhost/api/v1/badge?metric=calls30d', { MCP_STATS: mockDb(69) }))).json()) as Record<string, unknown>;
    expect(small.label).toBe('MCP calls (30d)');
    expect(small.message).toBe('69');

    const mid = (await (await onRequest(ctx('http://localhost/api/v1/badge?metric=calls', { MCP_STATS: mockDb(42_350) }))).json()) as Record<string, unknown>;
    expect(mid.message).toBe('42k');

    const big = (await (await onRequest(ctx('http://localhost/api/v1/badge?metric=calls', { MCP_STATS: mockDb(1_500_000) }))).json()) as Record<string, unknown>;
    expect(big.message).toBe('1.5M');
  });

  it('returns a 200 lightgrey badge when the binding is missing', async () => {
    const res = await onRequest(ctx('http://localhost/api/v1/badge', {}));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.message).toBe('n/a');
    expect(json.color).toBe('lightgrey');
  });

  it('returns a 200 unknown-metric badge for a bad metric param', async () => {
    const res = await onRequest(ctx('http://localhost/api/v1/badge?metric=bogus', { MCP_STATS: mockDb(1) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.message).toBe('unknown metric');
  });

  it('handles OPTIONS preflight with 204 + CORS', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/api/v1/badge', { method: 'OPTIONS' }),
      env: { MCP_STATS: mockDb(1) },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 405 for non-GET verbs', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/api/v1/badge', { method: 'POST' }),
      env: { MCP_STATS: mockDb(1) },
    });
    expect(res.status).toBe(405);
  });
});
