// AlphaLatitude Inc. © 2026
//
// REST `next_steps` envelope: every successful /api/v1/* response carries a
// constant per-endpoint block (free web tool, related endpoints, beta) so the
// highest-volume tool surface (~10x MCP tools/call) finally has an onward
// step. Errors stay bare. The block is constant so agents can cache or
// ignore it; nothing in it varies with the input.

import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { onRequest as amtIso } from '../functions/api/v1/amt-iso';
import { VALID_AMT_ISO_BODY, makeAmtIsoReq } from './helpers/amt-iso-fixture';

// The endpoint slugs that exist on disk (each functions/api/v1/<slug>.ts is
// one calculator endpoint; index/stats/badge are not calculators).
const NON_CALC = new Set(['index', 'stats', 'badge']);
const SLUGS = readdirSync('functions/api/v1')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .filter((s) => !NON_CALC.has(s));

describe('REST next_steps envelope', () => {
  it('a successful response carries web_tool, also_run, and beta', async () => {
    const res = await amtIso({ request: makeAmtIsoReq(VALID_AMT_ISO_BODY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      next_steps?: { web_tool: string; also_run: string[]; beta: string };
    };
    expect(body.ok).toBe(true);
    // Phase 2 (2026-08-05): the web_tool link carries the caller's resolved
    // scenario in a distinct `_sc` bucket.
    expect(body.next_steps?.web_tool).toMatch(
      /^https:\/\/optionsahoy\.com\/tools\/amt-iso\?src=rest_amt_iso_sc&mcp=[A-Za-z0-9_-]+$/,
    );
    expect(body.next_steps?.also_run).toContain('/api/v1/qsbs');
    expect(body.next_steps?.beta).toContain('optionsahoy.com/beta?src=rest_amt_iso');
  });

  it('an error response stays bare (no next_steps on failures)', async () => {
    const res = await amtIso({ request: makeAmtIsoReq({}) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.next_steps).toBeUndefined();
  });

  it('every calculator endpoint has a next_steps entry with valid targets', async () => {
    const { REST_NEXT_STEPS: map } = await import('../functions/_lib/api');
    for (const slug of SLUGS) {
      expect(map[slug], `missing next_steps for /api/v1/${slug}`).toBeDefined();
      expect(map[slug].web_tool).toMatch(/^https:\/\/optionsahoy\.com\/tools\/.+\?src=rest_/);
      for (const target of map[slug].also_run) {
        const targetSlug = target.replace('/api/v1/', '');
        expect(SLUGS, `${slug} advertises unknown endpoint ${target}`).toContain(targetSlug);
      }
    }
  });
});

describe('REST also_run graph stays consistent with the MCP related-tool graph', () => {
  // REST_NEXT_STEPS.also_run and sessions.ts PER_TOOL_RELATED encode the
  // same adjacency by hand on two surfaces. This pins them to each other so
  // a rebalance of one without the other fails loudly instead of drifting.
  it('every also_run edge matches a tool named in PER_TOOL_RELATED and vice versa', async () => {
    const { REST_NEXT_STEPS } = await import('../functions/_lib/api');
    const { PER_TOOL_RELATED } = await import('../functions/_lib/sessions');
    const { TOOLS } = await import('../functions/_lib/mcp-tools');
    const { SKILLS } = await import('../functions/_lib/a2a');
    const slugByTool = Object.fromEntries(SKILLS.map((s) => [s.id, s.rest.replace('/api/v1/', '')]));
    const toolBySlug = Object.fromEntries(SKILLS.map((s) => [s.rest.replace('/api/v1/', ''), s.id]));
    for (const t of TOOLS) {
      const restEdges = (REST_NEXT_STEPS[slugByTool[t.name]]?.also_run ?? [])
        .map((p: string) => toolBySlug[p.replace('/api/v1/', '')])
        .sort();
      const prose = PER_TOOL_RELATED[t.name as keyof typeof PER_TOOL_RELATED];
      const proseEdges = (prose.match(/[a-z]+(?:_[a-z]+)+/g) ?? []).filter((x: string) => x !== t.name).sort();
      expect(restEdges, `edge mismatch for ${t.name}`).toEqual([...new Set(proseEdges)].sort());
    }
  });
});

// --- cross-surface field-name invariant -------------------------------------
//
// REST and MCP both emit a field called `next_steps`. They are built by
// different modules (REST_NEXT_STEPS in _lib/api.ts, nextStepsFor in
// _lib/sessions.ts) and their payloads are deliberately NOT identical: MCP's
// `also_run` is prose for a model to read, REST's is an array of endpoint
// paths for a program to iterate, and MCP's `beta` appears only on the first
// call of a session. What must not drift is the NAME of the link field. They
// were `web_tool` and `free_tool` until 2026-08, which meant one product spoke
// two dialects of the same envelope for no reason.
describe('next_steps field names agree across REST and MCP', () => {
  it('both surfaces call the calculator link `web_tool`', async () => {
    const { REST_NEXT_STEPS } = await import('../functions/_lib/api');
    const { nextStepsFor } = await import('../functions/_lib/sessions');
    const rest = REST_NEXT_STEPS['amt-iso'] as unknown as Record<string, unknown>;
    const mcp = nextStepsFor('amt_iso_optimize', 1, undefined, undefined) as unknown as Record<string, unknown>;
    expect(typeof rest.web_tool).toBe('string');
    expect(typeof mcp.web_tool).toBe('string');
    // The old MCP name must not come back on either side.
    expect(rest).not.toHaveProperty('free_tool');
    expect(mcp).not.toHaveProperty('free_tool');
  });

  it('pins the shape differences that ARE intended', async () => {
    const { REST_NEXT_STEPS } = await import('../functions/_lib/api');
    const { nextStepsFor } = await import('../functions/_lib/sessions');
    // REST iterates, MCP reads. Changing either is a product decision, not a
    // refactor, so pin both.
    expect(Array.isArray(REST_NEXT_STEPS['amt-iso']!.also_run)).toBe(true);
    expect(typeof nextStepsFor('amt_iso_optimize', 1, undefined, undefined)!.also_run).toBe('string');
  });
});
