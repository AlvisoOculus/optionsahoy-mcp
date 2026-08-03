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
import type { D1Database, D1PreparedStatement } from '../functions/_lib/stats';
import { TOOLS, type ToolName } from '../functions/_lib/mcp-tools';

// Derived, NOT hand-listed: this array drives the per-tool sweep below, so a
// hand-written copy would skip any tool someone forgot to add to it — the same
// defect it exists to catch.
const ALL_TOOLS: ToolName[] = TOOLS.map((t) => t.name);

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
    // The canonical lines plus the session join token (s=<8-char prefix>).
    expect(inner._meta?.optionsahoy?.free_tool).toBe(`${PER_TOOL_FREE_TOOL.amt_iso_optimize}&s=sess-pit`);
    expect(inner._meta?.optionsahoy?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
    expect(inner._meta?.optionsahoy?.beta).toBe(`${PER_TOOL_BETA_INVITES.amt_iso_optimize}&s=sess-pit`);
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
    expect(inner._meta?.optionsahoy?.free_tool).toBe(`${PER_TOOL_FREE_TOOL_BARE.amt_iso_optimize}&s=sess-pit`);
    expect(inner._meta?.optionsahoy?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
    expect(inner._meta?.optionsahoy?.beta).toBeUndefined();
  });

  it('without a session header, injects the bare block and NEVER the beta pitch', async () => {
    // Changed 2026-08-03: sessionless calls used to get nothing. Production
    // showed ~98% of valid tool calls are sessionless and non-infra ones are
    // real SDK integrations, so they now get the bare form. The invariant
    // that survives: no session means no once-per-session pitch and no join
    // token, because there is nothing to dedupe against.
    const db = mockD1();
    const res = await onRequest({
      request: rpcRequest(amtIsoCall(1)),
      env: { MCP_STATS: db },
    });
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    const oa = (JSON.parse(body.result.content[0].text) as {
      _meta?: { optionsahoy?: { free_tool?: string; beta?: string } };
    })._meta?.optionsahoy;
    expect(oa?.free_tool).toBe(PER_TOOL_FREE_TOOL_BARE.amt_iso_optimize);
    expect(oa?.beta).toBeUndefined();
  });

  it('with a session header but no MCP_STATS binding, degrades to the bare block (cannot dedupe)', async () => {
    // No binding means no call-count row, so the once-per-session pitch
    // cannot be deduped - fall back to the same bare form sessionless
    // callers get rather than dropping the conversion surface entirely.
    const res = await onRequest({
      request: rpcRequest(amtIsoCall(1), 'sess-no-binding'),
      env: {},
    });
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    const oa = (JSON.parse(body.result.content[0].text) as {
      _meta?: { optionsahoy?: { free_tool?: string; beta?: string } };
    })._meta?.optionsahoy;
    expect(oa?.free_tool).toBe(PER_TOOL_FREE_TOOL_BARE.amt_iso_optimize);
    expect(oa?.beta).toBeUndefined();
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

describe('Mcp-Session-Id issuance (what arms the funnel)', () => {
  // Before this shipped, the server never issued a session id, so
  // spec-compliant clients never echoed one and the entire next-steps block
  // fired on 9 sessions out of ~62,000 calls. Streamable HTTP: the server MAY
  // assign an id at initialization; clients MUST then echo it. We issue and
  // do NOT enforce, so sessionless callers (scanners, curl) are untouched.
  const init = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  };

  it('issues a session id on initialize', async () => {
    const res = await onRequest({ request: rpcRequest(init), env: {} });
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    expect(sid!.length).toBeGreaterThanOrEqual(16);
  });

  it('echoes a client-supplied session id instead of minting a new one', async () => {
    const res = await onRequest({ request: rpcRequest(init, 'client-chose-this'), env: {} });
    expect(res.headers.get('mcp-session-id')).toBe('client-chose-this');
  });

  it('exposes the header to browser clients via CORS', async () => {
    const res = await onRequest({ request: rpcRequest(init), env: {} });
    expect(res.headers.get('access-control-expose-headers')).toMatch(/mcp-session-id/i);
  });

  it('non-initialize sessionless requests work unchanged and get no session header (issue, never enforce)', async () => {
    const res = await onRequest({
      request: rpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      env: {},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('DELETE (client session shutdown) gets a quiet 405, not an error-logged 405', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/mcp', { method: 'DELETE' }),
      env: {},
    });
    expect(res.status).toBe(405);
  });
});

describe('HEAD /mcp (health checkers)', () => {
  it('answers HEAD with 200, no body, logged as a non-error', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/mcp', { method: 'HEAD' }),
      env: {},
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('session join token on next-step URLs (MCP -> web attribution)', () => {
  it('free_tool and beta carry s=<8-char prefix>; also_run prose never does', async () => {
    const { nextStepsFor } = await import('../functions/_lib/sessions');
    const next = nextStepsFor('qsbs_check', 1, '679ea49a-90f4-4e79-88a4-1823824a878b');
    expect(next?.free_tool).toContain('?src=mcp_qsbs&s=679ea49a');
    expect(next?.beta).toContain('?src=mcp_qsbs&s=679ea49a');
    expect(next?.also_run).not.toContain('&s=');
  });

  it('later calls carry it on the bare URL too', async () => {
    const { nextStepsFor } = await import('../functions/_lib/sessions');
    const next = nextStepsFor('qsbs_check', 2, '679ea49a-90f4-4e79-88a4-1823824a878b');
    expect(next?.free_tool).toBe('optionsahoy.com/tools/qsbs?src=mcp_qsbs&s=679ea49a');
  });

  it('arbitrary client-supplied ids are sanitized; junk yields no param', async () => {
    const { nextStepsFor, sessionJoinToken } = await import('../functions/_lib/sessions');
    expect(sessionJoinToken('e2e-1785591713153')).toBe('e2e-1785');
    expect(sessionJoinToken('<script>alert(1)</script>')).toBe('scriptal');
    expect(sessionJoinToken('!!')).toBeNull();
    expect(sessionJoinToken(undefined)).toBeNull();
    const next = nextStepsFor('qsbs_check', 1, '!!');
    expect(next?.free_tool).not.toContain('&s=');
  });
});

describe('join-suffix URL invariant (every joinable line ends with its URL)', () => {
  // The s= append is only correct because these lines END with a
  // ?src=-carrying URL and no trailing punctuation. A future copy-edit that
  // breaks the shape would ship silently broken links; this pins all 8 tools
  // across all three tables.
  it('free-tool, bare, and beta lines all end with ?src=<bucket>', async () => {
    const { PER_TOOL_FREE_TOOL, PER_TOOL_FREE_TOOL_BARE, PER_TOOL_BETA_INVITES } = await import('../functions/_lib/sessions');
    for (const table of [PER_TOOL_FREE_TOOL, PER_TOOL_FREE_TOOL_BARE, PER_TOOL_BETA_INVITES]) {
      for (const [tool, line] of Object.entries(table)) {
        expect(line, `${tool} line must end with its ?src= URL`).toMatch(/\?src=[a-z_]+$/);
      }
    }
  });
});

describe('sessionless next-steps injection (the 98% of tool calls with no session)', () => {
  // Production disproved the original "sessionless == scanners" assumption:
  // in a 7-day window 928 of 942 valid tool calls arrived sessionless, and
  // the non-infra sample of those was entirely MCP SDK integrations
  // (python-httpx, node). Those callers now get the bare block; infra
  // callers (registry probes, scanners, our smoke) still get nothing.
  function callWithUa(ua: string | undefined) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (ua) headers['user-agent'] = ua;
    return new Request('http://localhost/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(amtIsoCall(1)),
    });
  }

  async function metaFor(ua: string | undefined) {
    const res = await onRequest({ request: callWithUa(ua), env: {} });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const inner = JSON.parse(body.result.content[0].text) as {
      _meta?: { optionsahoy?: { free_tool?: string; also_run?: string; beta?: string } };
    };
    return inner._meta?.optionsahoy;
  }

  it('an SDK caller with no session gets the bare free-tool + related block', async () => {
    const oa = await metaFor('python-httpx/0.28.1');
    expect(oa?.free_tool).toBe(PER_TOOL_FREE_TOOL_BARE.amt_iso_optimize);
    expect(oa?.also_run).toBe(PER_TOOL_RELATED.amt_iso_optimize);
  });

  it('never carries the beta pitch or a join token without a session (nothing to dedupe against)', async () => {
    const oa = await metaFor('node');
    expect(oa?.beta).toBeUndefined();
    expect(oa?.free_tool).not.toContain('&s=');
  });

  it('registry probes and scanners still get clean, unmarketed responses', async () => {
    for (const ua of ['mcpregistry/1.0', 'smithery-probe', 'oa-e2e-live', 'Googlebot/2.1']) {
      expect(await metaFor(ua), `${ua} must not be marketed to`).toBeUndefined();
    }
  });

  it('a session-bearing call still gets the full first-call block (unchanged path)', async () => {
    const res = await onRequest({
      request: rpcRequest(amtIsoCall(1), 'sess-inject-1'),
      env: { MCP_STATS: mockD1() },
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const oa = (JSON.parse(body.result.content[0].text) as {
      _meta?: { optionsahoy?: { beta?: string; free_tool?: string } };
    })._meta?.optionsahoy;
    expect(oa?.beta).toBeDefined();
    expect(oa?.free_tool).toContain('&s=sess-inj');
  });
});
