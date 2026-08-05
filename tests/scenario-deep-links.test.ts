// AlphaLatitude Inc. © 2026
//
// Scenario deep links: the free-tool link carries the caller's own arguments
// so they land on their numbers instead of an empty form. See
// ../../optionsahoy_web/docs/design/mcp-scenario-deep-links.md.
//
// The invariant that matters most here is the FAIL-SAFE one: landing on the
// wrong numbers is worse than landing on an empty form, so anything the
// encoder is unsure about must degrade to the bare link, never to a partial
// or truncated payload.
//
// The payload is the RESOLVED input - what the calculation actually ran on -
// not the caller's raw arguments. Several inputs are only conditionally
// required (an agent can pass a `ticker` and let the server derive the
// expected sale price, the volatility drag and the market return), and
// forwarding the raw arguments left those fields absent, so the web page
// filled them from its own sources and showed a materially different answer
// with every other field matching.

import { describe, it, expect } from 'vitest';
import {
  SCENARIO_SLUGS,
  MCP_SCENARIO_MAX_CHARS,
  encodeScenario,
  withScenario,
} from '../functions/_lib/scenario';
import { nextStepsFor, PER_TOOL_FREE_TOOL_BARE } from '../functions/_lib/sessions';
import { TOOL_SLUG } from '../functions/_lib/mcp-tools';
import { parseNsoInput } from '../functions/_lib/calc-parsers';
import { onRequest as nsoRest } from '../functions/api/v1/nso';
import { onRequest as qsbsRest } from '../functions/api/v1/qsbs';

const NSO_ARGS = {
  shares: 7777,
  strike: 3.5,
  currentPrice: 42,
  ordinaryIncome: 240000,
  filingStatus: 'single',
  stateCode: 'CA',
  stillEmployed: true,
  holdYears: 2,
  expectedSalePrice: 55,
  volatility: 0.3,
  expectedMarketReturn: 0.07,
  holdFunding: 'sell-to-cover',
};

function decode(payload: string): unknown {
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

// The `mcp=` value out of a next-steps line, or null if there is none.
function payloadOf(line: string): string | null {
  return line.match(/[?&]mcp=([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

describe('encodeScenario', () => {
  it('carries the resolved input, matching what the calculation ran on', () => {
    const payload = encodeScenario('nso', NSO_ARGS);
    expect(payload).toBeTruthy();
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, unpadded
    expect(decode(payload!)).toEqual(parseNsoInput(NSO_ARGS));
  });

  it('resolves the fields a ticker-only call leaves out', () => {
    // THE regression. This is the tool's own documented example shape: no
    // expectedSalePrice, no expectedMarketReturn, growth implied by the
    // ticker. Forwarding raw arguments dropped all three, and the page then
    // derived its own from a different return window - the agent said one
    // number, the page showed another, and everything else matched.
    const tickerCall = {
      shares: 5000, strike: 10, currentPrice: 50, ordinaryIncome: 180000,
      filingStatus: 'single', stateCode: 'CA', stillEmployed: true,
      holdYears: 2, volatility: 0.3, holdFunding: 'cash', ticker: 'AAPL',
    };
    const carried = decode(encodeScenario('nso', tickerCall)!) as Record<string, number>;
    const resolved = parseNsoInput(tickerCall) as unknown as Record<string, number>;
    for (const field of ['expectedSalePrice', 'haircut', 'expectedMarketReturn']) {
      expect(carried[field], `${field} must be carried, not left to the page`).toBe(resolved[field]);
      expect(Number.isFinite(carried[field])).toBe(true);
    }
  });

  it('carries only the parser fields, so no identity can ride along', () => {
    // Parsers ignore unknown keys, so a caller can attach anything to the
    // request. The scenario URL is handed to an agent and may be logged by
    // its host; the design's rule is that it carries calculator inputs only.
    const payload = encodeScenario('nso', {
      ...NSO_ARGS,
      clientEmail: 'jane@acme.com',
      clientName: 'Jane Doe',
    })!;
    const carried = decode(payload) as Record<string, unknown>;
    expect(Object.keys(carried).sort()).toEqual(Object.keys(parseNsoInput(NSO_ARGS)).sort());
    expect(JSON.stringify(carried)).not.toContain('acme.com');
  });

  it('survives multi-byte characters', () => {
    // btoa() throws on anything above U+00FF, so the encoder goes through
    // TextEncoder first. A ticker with a non-ASCII character would otherwise
    // take down the whole tools/call response.
    expect(encodeScenario('nso', { ...NSO_ARGS, ticker: '東京' })).toBeTruthy();
  });

  it('returns null for slugs with no web-side mapper', () => {
    // Phase 1 is nso only. A slug enabled here without a matching mapper in
    // the web repo would land users on defaults carrying a mystery param.
    expect(encodeScenario('qsbs', NSO_ARGS)).toBeNull();
    expect(encodeScenario('equity-funding', NSO_ARGS)).toBeNull();
  });

  it('returns null when there is nothing to carry', () => {
    for (const empty of [undefined, null, {}, [], 'string', 42]) {
      expect(encodeScenario('nso', empty), `should skip ${JSON.stringify(empty)}`).toBeNull();
    }
  });

  it('stays far under the cap now that the payload is a fixed field set', () => {
    // The cap is a backstop for tools whose input grows with the caller's
    // data (equity_funding_plan carries lot arrays), not something nso can
    // hit: its resolved input is twelve scalars.
    expect(encodeScenario('nso', NSO_ARGS)!.length).toBeLessThan(MCP_SCENARIO_MAX_CHARS / 2);
  });

  it('never throws when the arguments do not resolve', () => {
    // The parser is strict and throws; a caller whose arguments do not
    // resolve has no scenario worth carrying, and a tools/call response must
    // not fail over a link.
    const circular: Record<string, unknown> = { shares: 1 };
    circular.self = circular;
    for (const bad of [circular, { shares: 1n as unknown }, { ...NSO_ARGS, stateCode: 'ZZ' }]) {
      expect(encodeScenario('nso', bad)).toBeNull();
    }
  });
});

describe('withScenario', () => {
  it('appends the scenario bucket and payload to a src-terminated link', () => {
    expect(withScenario('optionsahoy.com/tools/nso?src=mcp_nso', 'ABC')).toBe(
      'optionsahoy.com/tools/nso?src=mcp_nso_sc&mcp=ABC',
    );
  });

  it('leaves the line alone when there is no payload or the shape changed', () => {
    const line = 'optionsahoy.com/tools/nso?src=mcp_nso';
    expect(withScenario(line, null)).toBe(line);
    // A trailing param other than src (a future refactor) must not get a
    // `_sc` glued onto it.
    const moved = 'optionsahoy.com/tools/nso?src=mcp_nso&utm=x';
    expect(withScenario(moved, 'ABC')).toBe(moved);
  });
});

describe('nextStepsFor with arguments', () => {
  it('carries the scenario on the free tool, in its own src bucket', () => {
    const next = nextStepsFor('nso_calculate', 1, undefined, NSO_ARGS)!;
    expect(next.free_tool).toContain('optionsahoy.com/tools/nso?src=mcp_nso_sc&mcp=');
    expect(decode(payloadOf(next.free_tool)!)).toEqual(parseNsoInput(NSO_ARGS));
  });

  it('never puts the scenario on the beta link', () => {
    // The beta page is a signup form, not a calculator: inputs there would be
    // exposure with no gain. Privacy note in the design doc.
    const next = nextStepsFor('nso_calculate', 1, undefined, NSO_ARGS)!;
    expect(next.beta).not.toContain('mcp=');
    expect(next.beta).toContain('optionsahoy.com/beta?src=mcp_nso');
  });

  it('keeps the join token last, after the scenario', () => {
    const next = nextStepsFor('nso_calculate', 1, '679ea49a-90f4-4e79-88a4-1823824a878b', NSO_ARGS)!;
    expect(next.free_tool).toMatch(/\?src=mcp_nso_sc&mcp=[A-Za-z0-9_-]+&s=679ea49a$/);
  });

  it('carries the scenario on later calls too, where the link is bare', () => {
    const next = nextStepsFor('nso_calculate', 2, undefined, NSO_ARGS)!;
    expect(next.free_tool).toMatch(/^optionsahoy\.com\/tools\/nso\?src=mcp_nso_sc&mcp=[A-Za-z0-9_-]+$/);
  });

  it('is unchanged for tools outside phase 1, and when no args are passed', () => {
    expect(nextStepsFor('qsbs_check', 1, undefined, { shares: 1 })!.free_tool).toMatch(/\?src=mcp_qsbs$/);
    expect(nextStepsFor('nso_calculate', 2)!.free_tool).toBe(PER_TOOL_FREE_TOOL_BARE.nso_calculate);
  });
});

describe('REST next_steps.web_tool', () => {
  function post(path: string, body: unknown): Request {
    return new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('carries the caller\'s own body to the web tool', async () => {
    const res = await nsoRest({ request: post('/api/v1/nso', NSO_ARGS) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { next_steps?: { web_tool: string; beta: string } };
    expect(body.next_steps?.web_tool).toContain('/tools/nso?src=rest_nso_sc&mcp=');
    // REST bodies and MCP tool arguments are the same shape - both feed
    // parseNsoInput - so one web-side mapper serves both surfaces.
    expect(decode(payloadOf(body.next_steps!.web_tool)!)).toEqual(parseNsoInput(NSO_ARGS));
    expect(body.next_steps?.beta).not.toContain('mcp=');
  });

  it('leaves endpoints outside phase 1 exactly as they were', async () => {
    const res = await qsbsRest({
      request: post('/api/v1/qsbs', {
        acquisitionDate: '2020-03-01',
        saleDate: '2026-03-15',
        entityType: 'us-c-corp',
        acquisitionMethod: 'original-issuance',
        assetCategory: 'under-50m',
        industry: 'tech-software',
        activeBusiness: 'yes',
        adjustedBasis: 50000,
        expectedGain: 5000000,
        stateCode: 'CA',
        ordinaryIncome: 300000,
        filingStatus: 'single',
      }),
    });
    const body = (await res.json()) as { next_steps?: { web_tool: string } };
    expect(body.next_steps?.web_tool).toBe('https://optionsahoy.com/tools/qsbs?src=rest_qsbs');
  });
});

describe('drift guards', () => {
  it('the scenario slug list is pinned - the web mapper must land first', () => {
    // THE cross-repo hazard. The web repo gates on its own list
    // (web/lib/mcpScenario.ts MCP_TO_STATE) and no test can see both. A slug
    // enabled here without a mapper there sends users to a calculator that
    // ignores the payload, in an `_sc` attribution bucket reporting a
    // scenario cohort that never existed. Pinning the list puts the
    // instruction in the way of the change.
    expect([...SCENARIO_SLUGS].sort()).toEqual(['nso']);
  });

  it('every scenario slug is a real calculator on both surfaces', async () => {
    const { REST_NEXT_STEPS } = await import('../functions/_lib/api');
    const mcpSlugs = new Set(Object.values(TOOL_SLUG));
    for (const slug of SCENARIO_SLUGS) {
      expect(REST_NEXT_STEPS[slug], `${slug} is not a REST endpoint`).toBeDefined();
      expect(mcpSlugs.has(slug), `${slug} is not an MCP tool target`).toBe(true);
    }
  });

  it('TOOL_SLUG agrees with the two places that already encode tool -> endpoint', async () => {
    // TOOL_SLUG is the declaration; SKILLS[].rest and the free-tool URLs are
    // hand-written copies of the same adjacency. Pin them to it so a
    // divergence fails loudly instead of silently routing somewhere else.
    const { SKILLS } = await import('../functions/_lib/a2a');
    for (const skill of SKILLS) {
      expect(TOOL_SLUG[skill.id], `slug mismatch for ${skill.id}`).toBe(skill.rest.replace('/api/v1/', ''));
    }
    for (const [name, slug] of Object.entries(TOOL_SLUG)) {
      expect(
        PER_TOOL_FREE_TOOL_BARE[name as keyof typeof PER_TOOL_FREE_TOOL_BARE],
        `free-tool URL for ${name} does not point at /tools/${slug}`,
      ).toContain(`/tools/${slug}?src=`);
    }
  });
});
