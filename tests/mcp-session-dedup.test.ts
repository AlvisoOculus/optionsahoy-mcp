// AlphaLatitude Inc. © 2026
//
// Tests for the per-MCP-session next-step injection dedup. Covers:
//   - bumpSessionCallCount returns 1, 2, 3 on successive calls
//   - first tools/call per session gets the full next-step block in _meta
//     (free tool + complementary tool + beta)
//   - subsequent calls get the bare free-tool URL only
//   - missing Mcp-Session-Id or MCP_STATS binding skips injection cleanly

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/mcp';
import {
  bumpSessionCallCount,
  nextStepsFor,
  PER_TOOL_FREE_TOOL,
  PER_TOOL_FREE_TOOL_BARE,
  PER_TOOL_RELATED,
  PER_TOOL_BETA_INVITES,
} from '../functions/_lib/sessions';

const ALL_TOOLS = [
  'amt_iso_optimize',
  'nso_calculate',
  'rsu_sell_vs_hold',
  'concentration_analyze',
  'protective_put_price',
  'qsbs_check',
  'equity_funding_plan',
  'rsu_lot_optimize',
];
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

describe('nextStepsFor', () => {
  it('returns the full three-layer block on count=1', () => {
    const next = nextStepsFor('amt_iso_optimize', 1);
    expect(next?.free_tool).toBe(PER_TOOL_FREE_TOOL.amt_iso_optimize);
    expect(next?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
    expect(next?.beta).toBe(PER_TOOL_BETA_INVITES.amt_iso_optimize);
  });

  it('on count>=2 keeps the bare free-tool URL and related tools but drops the beta pitch', () => {
    const second = nextStepsFor('amt_iso_optimize', 2);
    expect(second?.free_tool).toBe(PER_TOOL_FREE_TOOL_BARE.amt_iso_optimize);
    expect(second?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
    expect(second?.beta).toBeUndefined();
    const seventh = nextStepsFor('amt_iso_optimize', 7);
    expect(seventh?.free_tool).toBe(PER_TOOL_FREE_TOOL_BARE.amt_iso_optimize);
    expect(seventh?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
  });

  it('leads with the free tool, not the beta (free tools before beta)', () => {
    for (const name of ALL_TOOLS) {
      const next = nextStepsFor(name, 1);
      expect(next?.free_tool, `${name} free_tool missing`).toContain('optionsahoy.com/tools/');
      expect(next?.beta, `${name} beta should be the second ask`).toContain('optionsahoy.com/beta');
    }
  });

  it('returns undefined for an unknown tool (nothing to inject)', () => {
    expect(nextStepsFor('not_a_real_tool', 1)).toBeUndefined();
    expect(nextStepsFor('not_a_real_tool', 2)).toBeUndefined();
  });

  it('all 8 tools have a free-tool, bare URL, related nudge, and beta pitch', () => {
    for (const name of ALL_TOOLS) {
      expect(PER_TOOL_FREE_TOOL[name], `missing free tool for ${name}`).toBeTruthy();
      expect(PER_TOOL_FREE_TOOL_BARE[name], `missing bare URL for ${name}`).toBeTruthy();
      expect(PER_TOOL_RELATED[name], `missing related nudge for ${name}`).toBeTruthy();
      expect(PER_TOOL_BETA_INVITES[name], `missing beta pitch for ${name}`).toBeTruthy();
    }
  });

  it('every free-tool link (full and bare) carries its own ?src=mcp_ tag', () => {
    for (const [tool, line] of Object.entries(PER_TOOL_FREE_TOOL)) {
      expect(line, `${tool} free tool missing src tag`).toMatch(/\?src=mcp_/);
    }
    for (const [tool, url] of Object.entries(PER_TOOL_FREE_TOOL_BARE)) {
      expect(url, `${tool} bare URL missing src tag`).toMatch(/\?src=mcp_/);
    }
  });

  it('every related nudge points at a real tool name', () => {
    for (const name of ALL_TOOLS) {
      const nudge = PER_TOOL_RELATED[name];
      // The nudge must name at least one other tool to call next.
      const referencesAnother = ALL_TOOLS.some(
        (t) => t !== name && nudge.includes(t),
      );
      expect(referencesAnother, `${name} nudge names no other tool`).toBe(true);
    }
  });
});

describe('POST /mcp tools/call next-step injection', () => {
  it('injects the full three-layer block into _meta.optionsahoy on the first call per session', async () => {
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
      _meta?: { optionsahoy?: { free_tool?: string; also_run?: string; beta?: string } };
    };
    expect(inner._meta?.optionsahoy?.free_tool).toBe(PER_TOOL_FREE_TOOL.amt_iso_optimize);
    expect(inner._meta?.optionsahoy?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
    expect(inner._meta?.optionsahoy?.beta).toBe(PER_TOOL_BETA_INVITES.amt_iso_optimize);
  });

  it('switches to the bare free-tool URL on the second call in the same session', async () => {
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
      _meta?: { optionsahoy?: { free_tool?: string; also_run?: string; beta?: string } };
    };
    expect(inner._meta?.optionsahoy?.free_tool).toBe(PER_TOOL_FREE_TOOL_BARE.amt_iso_optimize);
    expect(inner._meta?.optionsahoy?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
    expect(inner._meta?.optionsahoy?.beta).toBeUndefined();
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
      _meta?: { optionsahoy?: unknown };
    };
    expect(inner._meta?.optionsahoy).toBeUndefined();
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
      _meta?: { optionsahoy?: unknown };
    };
    expect(inner._meta?.optionsahoy).toBeUndefined();
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
    expect(body.result.tools).toHaveLength(8);
    for (const tool of body.result.tools) {
      expect(
        tool.description,
        `${tool.name} description missing multi-tool note`,
      ).toContain('optionsahoy.com/beta?src=mcp_multi');
    }
  });
});
