// AlphaLatitude Inc. © 2026
//
// Coverage for the A2A (Agent2Agent) endpoint and card. Asserts the card is
// valid and matches the committed static file, that message/send routes to
// the right calculator deterministically (no language model), and that the
// JSON-RPC error paths behave.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { onRequest as a2aHandler } from '../functions/a2a';
import { buildAgentCard, SKILLS, routeByKeyword, handleMessage } from '../functions/_lib/a2a';
import { parseQsbsInput } from '../functions/_lib/calc-parsers';
import { parseConcentrationInput } from '../functions/_lib/calc-parsers';
import { evaluateQsbs } from '@/lib/calc/qsbs';
import { calculate as calculateConcentration } from '@/lib/calc/concentration';

function rpcReq(body: unknown): Request {
  return new Request('http://localhost/a2a', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sendMessage(parts: unknown[], id: unknown = 1): Request {
  return rpcReq({ jsonrpc: '2.0', id, method: 'message/send', params: { message: { parts } } });
}

// A2A skill ids are aligned 1:1 with the MCP tool names so a capability can be
// delegated across protocols under the same name.
const EXPECTED_SKILL_IDS = [
  'amt_iso_optimize',
  'nso_calculate',
  'rsu_sell_vs_hold',
  'concentration_analyze',
  'protective_put_price',
  'qsbs_check',
  'equity_funding_plan',
  'rsu_lot_optimize',
];

const QSBS_INPUT = {
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
};

const CONCENTRATION_INPUT = {
  positionValue: 1000000,
  costBasis: 200000,
  acquisitionDate: '2022-01-15',
  sector: 'tech_software',
  stateCode: 'CA',
  filingStatus: 'single',
  ordinaryIncome: 250000,
  totalAssets: 1500000,
  expectedPositionReturn: 0.1,
  expectedMarketReturn: 0.07,
  volatilityDrag: 0.2,
};

describe('A2A Agent Card', () => {
  it('has the expected protocol version, transport, and eight skills', () => {
    const card = buildAgentCard();
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.url).toBe('https://optionsahoy.com/a2a');
    const skills = card.skills as Array<{ id: string }>;
    expect(skills.map((s) => s.id)).toEqual(EXPECTED_SKILL_IDS);
  });

  it('every skill id has a runnable calculator and matches the live tool set', () => {
    expect(SKILLS.map((s) => s.id)).toEqual(EXPECTED_SKILL_IDS);
    for (const s of SKILLS) expect(typeof s.run).toBe('function');
  });

  it('the committed static cards match the generated card (drift guard)', () => {
    const generated = buildAgentCard();
    const cardFile = JSON.parse(readFileSync('public/.well-known/agent-card.json', 'utf8'));
    const legacyFile = JSON.parse(readFileSync('public/.well-known/agent.json', 'utf8'));
    expect(cardFile).toEqual(generated);
    expect(legacyFile).toEqual(generated);
  });

  it('card and skill prose carry no em-dash or emoji', () => {
    const text = JSON.stringify(buildAgentCard());
    expect(text).not.toMatch(/—/);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('GET /a2a returns the card', async () => {
    const res = await a2aHandler({
      request: new Request('http://localhost/a2a', { method: 'GET' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(buildAgentCard());
  });
});

describe('A2A message/send: deterministic dispatch', () => {
  it('runs the qsbs calculator from a structured data part, byte-identical to the REST calc', async () => {
    const res = await a2aHandler({
      request: sendMessage([{ kind: 'data', data: { skill: 'qsbs_check', input: QSBS_INPUT } }]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; result: { parts: Array<Record<string, unknown>> } };
    expect(body.id).toBe(1);
    const dataPart = body.result.parts.find((p) => p.kind === 'data');
    expect(dataPart?.data).toEqual(evaluateQsbs(parseQsbsInput(QSBS_INPUT)));
    const textPart = body.result.parts.find((p) => p.kind === 'text') as { text: string };
    expect(textPart.text).toContain('QSBS Section 1202 check');
  });

  it('runs the concentration calculator too', async () => {
    const res = await a2aHandler({
      request: sendMessage([
        { kind: 'data', data: { skill: 'concentration_analyze', input: CONCENTRATION_INPUT } },
      ]),
    });
    const body = (await res.json()) as { result: { parts: Array<Record<string, unknown>> } };
    const dataPart = body.result.parts.find((p) => p.kind === 'data');
    // The calc result carries Date fields that serialize to strings over JSON,
    // exactly as the REST endpoint does; round-trip the reference to compare.
    const reference = JSON.parse(
      JSON.stringify(calculateConcentration(parseConcentrationInput(CONCENTRATION_INPUT))),
    );
    expect(dataPart?.data).toEqual(reference);
  });

  it('returns a readable error message (not a JSON-RPC error) on invalid calculator input', async () => {
    const res = await a2aHandler({
      request: sendMessage([{ kind: 'data', data: { skill: 'qsbs_check', input: { adjustedBasis: -1 } } }]),
    });
    const body = (await res.json()) as { result: { parts: Array<{ text?: string }> }; error?: unknown };
    expect(body.error).toBeUndefined();
    const text = body.result.parts[0].text ?? '';
    expect(text).toContain('could not run that input');
    expect(text).toContain('/api/v1/qsbs');
  });

  it('lists the skills when the skill id is unknown', async () => {
    const res = await a2aHandler({
      request: sendMessage([{ kind: 'data', data: { skill: 'not_a_skill', input: {} } }]),
    });
    const body = (await res.json()) as { result: { parts: Array<{ text?: string }> } };
    const text = body.result.parts[0].text ?? '';
    expect(text).toContain('Unknown or missing "skill"');
    expect(text).toContain('amt_iso_optimize');
  });
});

describe('A2A free-text routing: no language model', () => {
  it('keyword-routes a QSBS question to the qsbs skill', () => {
    const matched = routeByKeyword('Do my shares qualify for the Section 1202 exclusion?');
    expect(matched?.id).toBe('qsbs_check');
  });

  it('keyword-routes an ISO/AMT question to amt_iso_optimize', () => {
    const matched = routeByKeyword('When should I exercise my incentive stock options for AMT?');
    expect(matched?.id).toBe('amt_iso_optimize');
  });

  it('points a matched free-text message at the skill and its schema', async () => {
    const res = await a2aHandler({
      request: sendMessage([
        { kind: 'text', text: 'Do my shares qualify for the qualified small business stock exclusion?' },
      ]),
    });
    const body = (await res.json()) as { result: { parts: Array<{ text?: string }> } };
    const text = body.result.parts[0].text ?? '';
    expect(text).toContain('QSBS Section 1202 check');
    expect(text).toContain('/openapi.json');
  });

  it('gives generic guidance when nothing matches', async () => {
    const res = await a2aHandler({
      request: sendMessage([{ kind: 'text', text: 'what is the weather today' }]),
    });
    const body = (await res.json()) as { result: { parts: Array<{ text?: string }> } };
    expect(body.result.parts[0].text).toContain('structured input');
  });
});

describe('A2A JSON-RPC and CORS', () => {
  it('OPTIONS preflight returns 204 with CORS', async () => {
    const res = await a2aHandler({
      request: new Request('http://localhost/a2a', { method: 'OPTIONS' }),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects a non-2.0 envelope with -32600', async () => {
    const res = await a2aHandler({ request: rpcReq({ id: 9, method: 'message/send' }) });
    const body = (await res.json()) as { id: number; error: { code: number } };
    expect(body.id).toBe(9);
    expect(body.error.code).toBe(-32600);
  });

  it('rejects an unknown method with -32601', async () => {
    const res = await a2aHandler({
      request: rpcReq({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: {} }),
    });
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain('message/send');
  });

  it('rejects invalid JSON with -32700', async () => {
    const res = await a2aHandler({
      request: new Request('http://localhost/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('rejects a missing parts array with -32602', async () => {
    const res = await a2aHandler({
      request: rpcReq({ jsonrpc: '2.0', id: 4, method: 'message/send', params: { message: {} } }),
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });
});

describe('A2A handleMessage helper', () => {
  it('reports the skill that ran for telemetry', () => {
    const ran = handleMessage([{ kind: 'data', data: { skill: 'qsbs_check', input: QSBS_INPUT } }]);
    expect(ran.skill).toBe('qsbs_check');
    const unmatched = handleMessage([{ kind: 'text', text: 'hello' }]);
    expect(unmatched.skill).toBeNull();
  });
});

describe('A2A free-text routing: punctuation and phrasing coverage', () => {
  // The production 30-day window showed 75% of message/send calls failing to
  // route, with zero visibility into why. The router now normalizes
  // punctuation on both sides; these lock in phrasings that used to fall
  // through to the generic fallback.
  const cases: Array<[string, string]> = [
    ['Should I exercise my ISOs? Worried about AMT.', 'amt_iso_optimize'],
    ['I have incentive stock options at a startup', 'amt_iso_optimize'],
    ['Tax on my NSOs?', 'nso_calculate'],
    ['My non-qualified options vest next month', 'nso_calculate'],
    ['Sell my RSUs?', 'rsu_sell_vs_hold'],
    ['I get restricted stock from my employer', 'rsu_sell_vs_hold'],
    ['Is this small business stock under 1202?', 'qsbs_check'],
    ['I need cash for tuition next fall', 'equity_funding_plan'],
    ['Selling to buy a house in two years', 'equity_funding_plan'],
    ['Better than FIFO for selling my company shares?', 'rsu_lot_optimize'],
  ];
  for (const [text, expected] of cases) {
    it(`routes "${text}" -> ${expected}`, () => {
      expect(routeByKeyword(text)?.id).toBe(expected);
    });
  }

  it('still returns null on unrelated text', () => {
    expect(routeByKeyword('what is the weather today')).toBeNull();
    expect(routeByKeyword('')).toBeNull();
  });

  it('every skill remains reachable by at least one of its own keywords (order sanity)', () => {
    // First-match-wins across SKILLS: adding a broad keyword to an early
    // skill must never shadow every path to a later one.
    for (const s of SKILLS) {
      const reachable = s.keywords.some((k) => routeByKeyword(k)?.id === s.id);
      expect(reachable, `${s.id} unreachable: all its keywords route elsewhere`).toBe(true);
    }
  });
});

describe('A2A telemetry semantics (isError / errorMsg / query)', () => {
  it('a routed free-text pointer is NOT an error (working as designed)', () => {
    const h = handleMessage([{ kind: 'text', text: 'Should I sell my RSUs?' }]);
    expect(h.skill).toBeNull();
    expect(h.isError).toBe(false);
    expect(h.errorMsg).toContain('rsu_sell_vs_hold');
    expect(h.query).toContain('RSUs');
  });

  it('unrouted free text is an error with the text captured', () => {
    const h = handleMessage([{ kind: 'text', text: 'what is the weather today' }]);
    expect(h.isError).toBe(true);
    expect(h.errorMsg).toBe('unrouted free text');
    expect(h.query).toBe('what is the weather today');
  });

  it('an unknown skill id names the id in errorMsg', () => {
    const h = handleMessage([{ kind: 'data', data: { skill: 'not_a_skill', input: {} } }]);
    expect(h.isError).toBe(true);
    expect(h.errorMsg).toBe('unknown skill: not_a_skill');
  });

  it('a calculator input failure carries the skill id and the parse message', () => {
    const h = handleMessage([{ kind: 'data', data: { skill: 'qsbs_check', input: {} } }]);
    expect(h.isError).toBe(true);
    expect(h.errorMsg).toMatch(/^qsbs_check: /);
  });

  it('a successful data call is not an error and echoes the input as query', () => {
    const input = {
      skill: 'rsu_lot_optimize',
      input: {
        lots: [{ vestDate: '2022-08-15', shares: 120, costBasisPerShare: 95 }],
        currentPrice: 180,
        divestFraction: 0.5,
        horizonYears: 1,
        ordinaryIncome: 200000,
        filingStatus: 'single',
        stateCode: 'CA',
      },
    };
    const h = handleMessage([{ kind: 'data', data: input }]);
    expect(h.isError).toBe(false);
    expect(h.skill).toBe('rsu_lot_optimize');
    expect(h.query).toBe(JSON.stringify(input));
  });
});
