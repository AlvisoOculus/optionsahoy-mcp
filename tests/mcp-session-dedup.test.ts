// AlphaLatitude Inc. © 2026
//
// Tests for the per-MCP-session beta-access pitch dedup. Covers:
//   - bumpSessionCallCount returns 1, 2, 3 on successive calls
//   - first tools/call per session gets the full per-tool pitch in _meta
//   - subsequent calls get the bare URL only
//   - missing Mcp-Session-Id or MCP_STATS binding skips injection cleanly

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/mcp';
import {
  bumpSessionCallCount,
  inviteFor,
  PER_TOOL_BETA_INVITES,
  MULTI_TOOL_BARE_URL,
} from '../functions/_lib/sessions';
import type { D1Database, D1PreparedStatement } from '../functions/_lib/stats';

// Mock D1 that simulates the UPSERT...RETURNING tool_call_count pattern.
// Tracks per-sessionId counters internally and returns the post-increment
// value just like the real DB does.
function mockD1(): D1Database {
  const counts = new Map<string, number>();
  return {
    prepare(_sql: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...vals: unknown[]) {
          bound = vals;
          return stmt;
        },
        async run() {
          return {};
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async first<T>() {
          const sessionId = String(bound[0]);
          const next = (counts.get(sessionId) ?? 0) + 1;
          counts.set(sessionId, next);
          return { tool_call_count: next } as T;
        },
      };
      return stmt;
    },
  };
}

function rpcRequest(body: unknown, sessionId?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// Minimal valid tools/call payload for amt_iso_optimize. Uses a ticker to
// skip the otherwise-required growth/vol fields.
function amtIsoCall(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'amt_iso_optimize',
      arguments: {
        shares: 1000,
        strike: 5,
        fmv: 50,
        ticker: 'AAPL',
        filingStatus: 'single',
        ordinaryIncome: 200000,
        stateCode: 'CA',
        carryforwardCredit: 0,
        horizon: 4,
        cashReturnRate: 0.04,
        grantDate: '2022-01-15',
        hasLeftCompany: false,
        terminationDate: null,
      },
    },
  };
}

describe('bumpSessionCallCount', () => {
  it('returns 1 on the first call and increments on subsequent calls', async () => {
    const db = mockD1();
    expect(await bumpSessionCallCount(db, 'sess-1')).toBe(1);
    expect(await bumpSessionCallCount(db, 'sess-1')).toBe(2);
    expect(await bumpSessionCallCount(db, 'sess-1')).toBe(3);
  });

  it('tracks counts independently per sessionId', async () => {
    const db = mockD1();
    await bumpSessionCallCount(db, 'sess-A');
    expect(await bumpSessionCallCount(db, 'sess-B')).toBe(1);
    expect(await bumpSessionCallCount(db, 'sess-A')).toBe(2);
  });
});

describe('inviteFor', () => {
  it('returns the per-tool full pitch on count=1', () => {
    expect(inviteFor('amt_iso_optimize', 1)).toBe(PER_TOOL_BETA_INVITES.amt_iso_optimize);
    expect(inviteFor('nso_calculate', 1)).toBe(PER_TOOL_BETA_INVITES.nso_calculate);
  });

  it('returns the bare multi-tool URL on count>=2', () => {
    expect(inviteFor('amt_iso_optimize', 2)).toBe(MULTI_TOOL_BARE_URL);
    expect(inviteFor('amt_iso_optimize', 7)).toBe(MULTI_TOOL_BARE_URL);
  });

  it('returns undefined for an unknown tool on count=1 (no pitch to inject)', () => {
    expect(inviteFor('not_a_real_tool', 1)).toBeUndefined();
  });

  it('all 7 tools have a per-tool pitch mapped', () => {
    const expected = [
      'amt_iso_optimize',
      'nso_calculate',
      'rsu_sell_vs_hold',
      'concentration_analyze',
      'protective_put_price',
      'qsbs_check',
      'equity_funding_plan',
    ];
    for (const name of expected) {
      expect(PER_TOOL_BETA_INVITES[name], `missing pitch for ${name}`).toBeTruthy();
    }
  });

  it('every per-tool pitch carries its own ?src= tag', () => {
    for (const [tool, pitch] of Object.entries(PER_TOOL_BETA_INVITES)) {
      expect(pitch, `${tool} pitch missing src tag`).toMatch(/\?src=mcp_/);
    }
  });
});

describe('POST /mcp tools/call beta_invite injection', () => {
  it('injects the full per-tool pitch into _meta on the first call per session', async () => {
    const db = mockD1();
    const res = await onRequest({
      request: rpcRequest(amtIsoCall(1), 'sess-pitch-1'),
      env: { MCP_STATS: db },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    const inner = JSON.parse(body.result.content[0].text) as {
      _meta?: { beta_invite?: string };
    };
    expect(inner._meta?.beta_invite).toBe(PER_TOOL_BETA_INVITES.amt_iso_optimize);
  });

  it('switches to the bare URL on the second call in the same session', async () => {
    const db = mockD1();
    await onRequest({
      request: rpcRequest(amtIsoCall(1), 'sess-pitch-2'),
      env: { MCP_STATS: db },
    });
    const second = await onRequest({
      request: rpcRequest(amtIsoCall(2), 'sess-pitch-2'),
      env: { MCP_STATS: db },
    });
    const body = (await second.json()) as {
      result: { content: { text: string }[] };
    };
    const inner = JSON.parse(body.result.content[0].text) as {
      _meta?: { beta_invite?: string };
    };
    expect(inner._meta?.beta_invite).toBe(MULTI_TOOL_BARE_URL);
  });

  it('skips injection when no Mcp-Session-Id header is sent', async () => {
    const db = mockD1();
    const res = await onRequest({
      request: rpcRequest(amtIsoCall(1)),
      env: { MCP_STATS: db },
    });
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    const inner = JSON.parse(body.result.content[0].text) as {
      _meta?: { beta_invite?: string };
    };
    expect(inner._meta?.beta_invite).toBeUndefined();
  });

  it('skips injection when MCP_STATS binding is missing', async () => {
    const res = await onRequest({
      request: rpcRequest(amtIsoCall(1), 'sess-no-binding'),
      env: {},
    });
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    const inner = JSON.parse(body.result.content[0].text) as {
      _meta?: { beta_invite?: string };
    };
    expect(inner._meta?.beta_invite).toBeUndefined();
  });
});

describe('multi-tool meta-instruction in tool descriptions', () => {
  it('every tool description carries the multi-tool beta note', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    });
    const body = (await res.json()) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(body.result.tools).toHaveLength(7);
    for (const tool of body.result.tools) {
      expect(
        tool.description,
        `${tool.name} description missing multi-tool note`,
      ).toContain('optionsahoy.com/beta?src=mcp_multi');
    }
  });
});
