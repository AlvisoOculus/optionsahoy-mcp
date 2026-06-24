// AlphaLatitude Inc. © 2026
//
// Comprehensive tests for the Poe server-bot endpoint (functions/poe.ts).
// The query path is driven with an injected extractor (no network to Poe);
// the deterministic calculation still runs through the real TOOLS handlers.
// A separate live extraction check (real model -> args) lives in
// scripts/poe-e2e-extract.mts, run manually with an OpenRouter key.

import { describe, it, expect } from 'vitest';
import {
  onRequest,
  handleQuery,
  headline,
  helpText,
  toolSpec,
  freeToolLink,
  parseJsonObject,
  extractorPrompt,
  pricingActive,
  priceMilliCents,
  priceUsd,
} from '../functions/poe';

const KEY = 'i2xRD3eNjktfohwlGLWBh1UGwB69Ky5w';
const ALL_TOOLS = [
  'amt_iso_optimize', 'nso_calculate', 'rsu_sell_vs_hold', 'concentration_analyze',
  'protective_put_price', 'qsbs_check', 'equity_funding_plan',
];

// Valid inputs for each tool that compute cleanly (rate/ticker supplied where
// the calc needs a forward estimate).
const VALID_ARGS: Record<string, any> = {
  amt_iso_optimize: {
    shares: 20000, strike: 2, fmv: 200, expectedGrowth: 0.17, volatility: 0.72,
    filingStatus: 'married_joint', ordinaryIncome: 300000, stateCode: 'CA',
    horizon: 4, cashReturnRate: 0.055, grantDate: '2022-01-01',
  },
  nso_calculate: {
    shares: 5000, strike: 10, currentPrice: 50, ordinaryIncome: 180000,
    filingStatus: 'single', stateCode: 'CA', stillEmployed: true, holdYears: 2, ticker: 'AAPL',
  },
  rsu_sell_vs_hold: {
    shares: 1000, currentPrice: 100, ordinaryIncome: 200000, filingStatus: 'single',
    stateCode: 'CA', stillEmployed: true, holdYears: 2, ticker: 'MSFT',
  },
  concentration_analyze: {
    positionValue: 400000, costBasis: 100000, acquisitionDate: '2022-01-01', sector: 'tech_software',
    stateCode: 'CA', filingStatus: 'single', ordinaryIncome: 200000, totalAssets: 1200000, ticker: 'NVDA',
  },
  protective_put_price: { positionValue: 400000, sector: 'tech_software', protectionLevel: 0.1, tenorYears: 1 },
  qsbs_check: {
    acquisitionDate: '2020-01-15', saleDate: '2026-06-01', entityType: 'us-c-corp',
    acquisitionMethod: 'original-issuance', assetCategory: 'under-50m', industry: 'tech-software',
    activeBusiness: 'yes', adjustedBasis: 100000, expectedGain: 5000000, stateCode: 'CA',
    ordinaryIncome: 250000, filingStatus: 'single',
  },
  equity_funding_plan: {
    targetAfterTax: 400000, targetDate: '2028-06-01',
    stacks: [{ ticker: 'NVDA', currentPrice: 140, expectedAnnualGrowth: 0.15, volatility: 0.45, lots: [{ shares: 4000, costBasisPerShare: 60, acquisitionDate: '2023-06-15' }] }],
    ordinaryIncome: 280000, filingStatus: 'married_joint', stateCode: 'CA', cashInterestRate: 0.04, riskToleranceShortfall: 0.1,
  },
};

// A phrase unique to each tool's comparison, to prove the answer is substantive.
const COMPARISON_MARKER: Record<string, RegExp> = {
  amt_iso_optimize: /more than/,
  nso_calculate: /wins by/,
  rsu_sell_vs_hold: /wins by/,
  concentration_analyze: /Downside scenarios/,
  protective_put_price: /collar/,
  qsbs_check: /exclusion/,
  equity_funding_plan: /safe to aggressive/,
};

function poeRequest(body: unknown, auth?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers['authorization'] = auth;
  return new Request('http://localhost/poe', { method: 'POST', headers, body: JSON.stringify(body) });
}
function ctx(env: Record<string, unknown> = {}): any {
  return { request: new Request('http://localhost/poe', { method: 'POST' }), env };
}
function sseText(raw: string): string {
  const m = raw.match(/event: text\ndata: (.*)/);
  return m ? JSON.parse(m[1]).text : '';
}
// Default user content mentions "growth" so the anti-fabrication guard treats a
// supplied expectedGrowth as user-given (tests that need the no-growth path pass
// an explicit content).
async function ask(tool: string, args: any, env: Record<string, unknown> = {}, req: any = {}, content = 'here are my details, including the growth and volatility I gave'): Promise<string> {
  const res = await handleQuery(ctx(env), { type: 'query', query: [{ role: 'user', content }], ...req }, async () => ({ tool, args }));
  return sseText(await res.text());
}

// --- HTTP method + auth + settings -----------------------------------------

describe('poe HTTP surface', () => {
  it('OPTIONS returns 204', async () => {
    const res = await onRequest({ request: new Request('http://x/poe', { method: 'OPTIONS' }), env: {} } as any);
    expect(res.status).toBe(204);
  });
  it('GET returns a friendly 200 (browser / health check)', async () => {
    const res = await onRequest({ request: new Request('http://x/poe', { method: 'GET' }), env: {} } as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Poe server bot');
  });
  it('rejects a query with a wrong bearer when the key is set', async () => {
    const res = await onRequest({ request: poeRequest({ type: 'query', query: [] }, 'Bearer wrong'), env: { POE_ACCESS_KEY: KEY } } as any);
    expect(res.status).toBe(401);
  });
  it('accepts settings with the correct bearer', async () => {
    const res = await onRequest({ request: poeRequest({ type: 'settings' }, `Bearer ${KEY}`), env: { POE_ACCESS_KEY: KEY } } as any);
    expect(res.status).toBe(200);
  });
  it('skips auth when no key is configured', async () => {
    const res = await onRequest({ request: poeRequest({ type: 'settings' }), env: {} } as any);
    expect(res.status).toBe(200);
  });
  it('report_* and unknown types return 200 with no body', async () => {
    const res = await onRequest({ request: poeRequest({ type: 'report_feedback' }), env: {} } as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('poe settings payload', () => {
  it('declares NO Poe dependencies (extraction runs on our model), with intro + free rate card', async () => {
    const body = (await (await onRequest({ request: poeRequest({ type: 'settings' }), env: {} } as any)).json()) as any;
    expect(Object.keys(body.server_bot_dependencies).length).toBe(0);
    expect(typeof body.introduction_message).toBe('string');
    expect(body.content_type).toBe('text/markdown');
    expect(body.cost_label).toBeTruthy();
    expect(body.rate_card).toContain('per answer');
  });
  it('shows a paid rate card once charging', async () => {
    const body = (await (await onRequest({ request: poeRequest({ type: 'settings' }), env: { POE_FREE_UNTIL: '2020-01-01' } } as any)).json()) as any;
    expect(body.cost_label).toMatch(/\$0\.30/);
  });
});

// --- routing + compute for every tool --------------------------------------

describe('poe answers (all 7 tools)', () => {
  for (const tool of ALL_TOOLS) {
    it(`${tool}: returns a headline, a comparison, and the free-tool link`, async () => {
      const text = await ask(tool, VALID_ARGS[tool]);
      expect(text).toContain('**'); // bold headline
      expect(text).toMatch(COMPARISON_MARKER[tool]);
      expect(text).toContain(`?src=poe_`);
      expect(text).toContain('not estimated');
      expect(text).not.toMatch(/I need a bit more|could not parse/);
    });
  }
});

// --- help / capability -----------------------------------------------------

describe('poe help', () => {
  it('general help lists every tool and an example', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'help' }] }, async () => ({ help: 'general' }));
    const text = await res.text();
    expect(text).toContain('what I can do');
    expect(text).toContain('Example');
    for (const frag of ['incentive stock option', 'non-qualified', 'restricted stock', 'concentration', 'hedge', 'QSBS', 'cash goal']) {
      expect(text).toContain(frag);
    }
  });
  it('help with a bare boolean falls back to general', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'x' }] }, async () => ({ help: true }));
    expect(await res.text()).toContain('what I can do');
  });
  it('tool-specific help gives that tool inputs + an example', () => {
    const t = helpText('qsbs_check');
    expect(t).toContain('qualified small business stock');
    expect(t).toContain('Example:');
    expect(t).not.toContain('incentive stock option'); // not the general menu
  });
});

// --- clarify / reject / fallbacks ------------------------------------------

describe('poe clarify / reject / fallback', () => {
  it('relays a clarify question verbatim', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'q' }] }, async () => ({ clarify: 'What is your filing status?' }));
    expect(await res.text()).toContain('What is your filing status?');
  });
  it('handles an off-topic rejection', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'q' }] }, async () => ({ reject: 'That is off topic.' }));
    expect(await res.text()).toContain('off topic');
  });
  it('returns the intro for an empty query', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [] }, async () => null);
    expect(await res.text()).toContain('equity-compensation');
  });
  it('falls back when extraction yields nothing', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'x' }] }, async () => null);
    expect(await res.text()).toContain('optionsahoy.com/tools');
  });
  it('returns the intro for an unknown tool name', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'x' }] }, async () => ({ tool: 'not_a_tool', args: {} }));
    expect(await res.text()).toContain('equity-compensation');
  });
  it('treats an extractor that throws as no-parse', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'x' }] }, async () => { throw new Error('boom'); });
    expect(await res.text()).toContain('optionsahoy.com/tools');
  });
  it('uses a one-word ticker reply deterministically after a ticker request', async () => {
    // The flaky model sometimes drops the bare "nvda"; handleQuery sets it.
    const a = { shares: 10000, strike: 2, fmv: 40, filingStatus: 'married_joint', ordinaryIncome: 300000, stateCode: 'CA', horizon: 4, cashReturnRate: 0.05, grantDate: '2022-01-01' };
    const res = await handleQuery(ctx(), { type: 'query', query: [
      { role: 'user', content: '10,000 ISOs, $2 strike, $40 value, MFJ, $300k income, CA, 4-year, granted 2022-01-01, 5% cash' },
      { role: 'bot', content: 'Give me the stock ticker or a growth rate' },
      { role: 'user', content: 'nvda' },
    ] }, async () => ({ tool: 'amt_iso_optimize', args: a }));
    expect(await res.text()).toContain('most money after taxes');
  });

  it('passes the full recent transcript (so a "nvda" follow-up keeps the original scenario)', async () => {
    let seen = '';
    const res = await handleQuery(ctx(), { type: 'query', query: [
      { role: 'user', content: '10,000 ISOs, $2 strike, MFJ, CA' },
      { role: 'bot', content: 'give me a ticker or a growth rate' },
      { role: 'user', content: 'nvda' },
    ] }, async (c) => { seen = c; return { clarify: 'ok' }; });
    await res.text();
    expect(seen).toContain('nvda');
    expect(seen).toContain('10,000 ISOs'); // earlier turn retained
    expect(seen).toContain('Assistant:'); // bot turn included as context
  });
});

// --- input defaults --------------------------------------------------------

describe('poe input defaults', () => {
  it('fills safe boilerplate the user never states', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize };
    delete a.carryforwardCredit; delete a.hasLeftCompany; delete a.terminationDate;
    expect(await ask('amt_iso_optimize', a)).toContain('most money after taxes');
  });
  it('ignores extractor-emitted null/blank so defaults still apply', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, carryforwardCredit: null, hasLeftCompany: null, terminationDate: null };
    expect(await ask('amt_iso_optimize', a)).toContain('most money after taxes');
  });
});

// --- error reformatting ----------------------------------------------------

describe('poe error reformatting', () => {
  it('a thorough question missing only the growth rate gets a clean, specific ask', async () => {
    // Mirrors the real user message: full ISO scenario but no growth / ticker.
    const a = { ...VALID_ARGS.amt_iso_optimize };
    delete a.expectedGrowth; delete a.volatility;
    const text = await ask('amt_iso_optimize', a);
    expect(text).toContain('ticker'); // leads with the easy option
    expect(text).toContain('growth rate');
    // none of the raw, model-facing engine phrasing leaks through
    expect(text).not.toContain('The model invoking');
    expect(text).not.toContain('MUST NOT');
    expect(text).not.toContain('covered public-stock symbol');
    expect(text).not.toMatch(/field "expectedGrowth"/);
  });

  it('strips a fabricated growth rate when the user never gave one (no guessing)', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, expectedGrowth: 0.25 };
    delete a.volatility; delete (a as any).ticker;
    // user content has NO growth word and no ticker -> model "invented" 25%
    const text = await ask('amt_iso_optimize', a, {}, {}, '10,000 ISOs, $2 strike, $40 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash return.');
    expect(text).toContain('growth rate'); // asked, did not compute on a made-up number
    expect(text).not.toContain('most money after taxes');
  });
  it('keeps growth + volatility when the user gave both, and discloses them', async () => {
    const text = await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize, {}, {}, 'best schedule, assume 17% growth and 0.72 volatility');
    expect(text).toContain('most money after taxes');
    expect(text).toContain('Assumptions:'); // discloses what it assumed
    expect(text).toContain('17%');
  });
  it('discloses ticker-derived assumptions', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, ticker: 'NVDA' };
    delete a.expectedGrowth; delete a.volatility;
    const text = await ask('amt_iso_optimize', a, {}, {}, 'my NVDA ISOs, best schedule');
    expect(text).toContain('Assumptions:');
    expect(text).toContain('NVDA');
  });

  it('asks plainly for a missing current price (no live quote, no raw error)', async () => {
    const a = { ...VALID_ARGS.equity_funding_plan };
    a.stacks = [{ ticker: 'NVDA', lots: [{ shares: 4000, costBasisPerShare: 60, acquisitionDate: '2023-06-15' }], expectedAnnualGrowth: 0.15, volatility: 0.45 }]; // no currentPrice
    const text = await ask('equity_funding_plan', a, {}, {}, 'fund $400k from my NVDA, growth and volatility given');
    expect(text).toMatch(/trading at now|current price/);
    expect(text).not.toMatch(/field "currentPrice"/);
    expect(text).not.toContain('must be a finite number');
  });

  it('a non-rate missing field still falls back to a cleaned engine hint', async () => {
    // nso without holdYears (required, not a rate field) -> generic clean ask.
    const a = { ...VALID_ARGS.nso_calculate };
    delete a.holdYears;
    const text = await ask('nso_calculate', a);
    expect(text).toMatch(/need a bit more|hold/i);
    expect(text).not.toContain('The model invoking');
  });
});

// --- pricing / monetization ------------------------------------------------

describe('poe pricing', () => {
  it('helpers default to $0.30 and honor the free window', () => {
    expect(priceMilliCents({})).toBe(30000);
    expect(priceUsd({})).toBe('$0.30');
    expect(pricingActive({ POE_FREE_UNTIL: '2099-01-01' })).toBe(false);
    expect(pricingActive({ POE_FREE_UNTIL: '2020-01-01' })).toBe(true);
    expect(pricingActive({ POE_FREE_UNTIL: '2020-01-01', POE_PRICE_MILLI_CENTS: '0' })).toBe(false);
  });
  it('free period: answer links the free tool', async () => {
    const text = await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize); // default env = free
    expect(text).toContain('/tools/amt-iso?src=poe_amt_iso');
    expect(text).toContain('free');
  });
  it('paid period: answer points to beta, NOT the free tool', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, text: async () => '' } as any)) as any;
    try {
      const text = await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize, { POE_FREE_UNTIL: '2020-01-01', POE_ACCESS_KEY: KEY }, { bot_query_id: 'bq' });
      expect(text).toContain('optionsahoy.com/beta');
      expect(text).not.toContain('/tools/amt-iso');
    } finally { globalThis.fetch = orig; }
  });
  it('does not call the cost API during the free period', async () => {
    let called = false; const orig = globalThis.fetch;
    globalThis.fetch = (async () => { called = true; return { ok: true, text: async () => '' } as any; }) as any;
    try {
      await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize, { POE_FREE_UNTIL: '2099-01-01', POE_ACCESS_KEY: KEY }, { bot_query_id: 'bq' });
      expect(called).toBe(false);
    } finally { globalThis.fetch = orig; }
  });
  it('authorizes then captures once charging', async () => {
    const calls: string[] = []; const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any) => { calls.push(String(u)); return { ok: true, text: async () => '' } as any; }) as any;
    try {
      await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize, { POE_FREE_UNTIL: '2020-01-01', POE_ACCESS_KEY: KEY }, { bot_query_id: 'bq1' });
      expect(calls.some((u) => u.includes('/cost/bq1/authorize'))).toBe(true);
      expect(calls.some((u) => u.includes('/cost/bq1/capture'))).toBe(true);
    } finally { globalThis.fetch = orig; }
  });
  it('blocks with an error event when the balance cannot cover the charge', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any) => ({ ok: !String(u).includes('authorize'), text: async () => '' } as any)) as any;
    try {
      const res = await handleQuery(ctx({ POE_FREE_UNTIL: '2020-01-01', POE_ACCESS_KEY: KEY }),
        { type: 'query', query: [{ role: 'user', content: 'q' }], bot_query_id: 'bq2' },
        async () => ({ tool: 'amt_iso_optimize', args: VALID_ARGS.amt_iso_optimize }));
      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('per answer');
    } finally { globalThis.fetch = orig; }
  });
});

// --- pure helpers ----------------------------------------------------------

describe('poe helpers', () => {
  it('freeToolLink retags mcp -> poe and keeps the slug', () => {
    expect(freeToolLink('qsbs_check')).toBe('optionsahoy.com/tools/qsbs?src=poe_qsbs');
  });
  it('parseJsonObject handles fenced, bare, and absent JSON', () => {
    expect(parseJsonObject('```json\n{"tool":"x"}\n```')).toEqual({ tool: 'x' });
    expect(parseJsonObject('noise {"a":1} tail')).toEqual({ a: 1 });
    expect(parseJsonObject('no json')).toBeNull();
  });
  it('headline falls back for an unknown result shape', () => {
    expect(headline('amt_iso_optimize', {})).toContain('result is ready');
  });
  it('extractorPrompt lists all 7 tools and the help rule', () => {
    const p = extractorPrompt('q');
    for (const t of ALL_TOOLS) expect(p).toContain(t);
    expect(p).toContain('{"help"');
    expect(p).toContain('{"clarify"');
    expect(p).toContain('{"reject"');
  });
  it('toolSpec exposes required fields, enum values, and an example per tool', () => {
    const spec = toolSpec();
    expect(spec).toContain('filingStatus=[single|married_joint|head_household]');
    expect(spec).toContain('sector=[tech_software'); // concentration / protective put enum
    expect(spec).toContain('Example args:');
    for (const t of ALL_TOOLS) expect(spec).toContain(t);
  });
});
