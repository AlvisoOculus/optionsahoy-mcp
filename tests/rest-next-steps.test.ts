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

const VALID_BODY = {
  shares: 5000,
  strike: 4,
  fmv: 90,
  expectedGrowth: 0.1,
  volatilityDrag: 0.2,
  filingStatus: 'single',
  ordinaryIncome: 250000,
  stateCode: 'CA',
  carryforwardCredit: 0,
  horizon: 4,
  cashReturnRate: 0.05,
  grantDate: '2024-05-20',
  hasLeftCompany: false,
  terminationDate: null,
};

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/v1/amt-iso', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The endpoint slugs that exist on disk (each functions/api/v1/<slug>.ts is
// one calculator endpoint; index/stats/badge are not calculators).
const NON_CALC = new Set(['index', 'stats', 'badge']);
const SLUGS = readdirSync('functions/api/v1')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .filter((s) => !NON_CALC.has(s));

describe('REST next_steps envelope', () => {
  it('a successful response carries web_tool, also_run, and beta', async () => {
    const res = await amtIso({ request: makeReq(VALID_BODY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      next_steps?: { web_tool: string; also_run: string[]; beta: string };
    };
    expect(body.ok).toBe(true);
    expect(body.next_steps?.web_tool).toBe('https://optionsahoy.com/tools/amt-iso?src=rest_amt_iso');
    expect(body.next_steps?.also_run).toContain('/api/v1/qsbs');
    expect(body.next_steps?.beta).toContain('optionsahoy.com/beta?src=rest_amt_iso');
  });

  it('an error response stays bare (no next_steps on failures)', async () => {
    const res = await amtIso({ request: makeReq({}) });
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
