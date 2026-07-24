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
  concentration_analyze: /single-stock risk faster/,
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
// Every number nested in the args (so the default content states them and the
// anti-fabrication guard keeps them; the real model gets these from user text).
function numbersIn(o: any): (number | string)[] {
  const out: (number | string)[] = [];
  const walk = (x: any) => {
    if (typeof x === 'number') out.push(x);
    else if (typeof x === 'string' && /^\d{4}(-\d{2}){0,2}$/.test(x)) out.push(x); // dates count as stated
    else if (typeof x === 'string' && /^[A-Z][A-Za-z.\-]{0,5}$/.test(x)) out.push(x); // tickers count as stated
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(o);
  return out;
}
// Default content states every number in the args, so the guard treats them as
// user-given. Tests of the strip/ask paths pass explicit content that omits the
// number being tested.
// Deterministic free-period env. Tests that assert FREE-branch behavior (the
// free-tool link, "free" wording, the free rate card) must pin this instead of
// relying on the code's DEFAULT_FREE_UNTIL — that default is a real calendar
// date, and when it passed (2026-07-22) every unpinned free-branch assertion
// time-bombed red with zero code change. Paid-branch tests pin '2020-01-01'.
const FREE_ENV = { POE_FREE_UNTIL: '2099-01-01' } as const;

async function ask(tool: string, args: any, env: Record<string, unknown> = {}, req: any = {}, content?: string): Promise<string> {
  const c = content ?? `my details: ${numbersIn(args).join(' ')}`;
  const res = await handleQuery(ctx(env), { type: 'query', query: [{ role: 'user', content: c }], ...req }, async () => ({ tool, args }));
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
    const body = (await (await onRequest({ request: poeRequest({ type: 'settings' }), env: FREE_ENV } as any)).json()) as any;
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
      const text = await ask(tool, VALID_ARGS[tool], FREE_ENV);
      expect(text).toContain('**'); // bold headline
      expect(text).toMatch(COMPARISON_MARKER[tool]);
      expect(text).toContain(`?src=poe_`);
      expect(text).toContain('not estimated');
      expect(text).not.toMatch(/I need a bit more|could not parse/);
    });
  }
});

// Each answer must carry the substantive detail the web tool shows, not a
// vague "see the tool" punt. These guard the richness, tool by tool.
describe('poe answers carry web-grade detail', () => {
  it('concentration: advisor benchmark, sell-pace wealth/tax, and a hedge cost', async () => {
    const text = await ask('concentration_analyze', VALID_ARGS.concentration_analyze);
    expect(text).toMatch(/advisors target|single name/i); // advisor benchmark
    expect(text).toMatch(/leaves about \$[\d,]+ after/); // plan wealth + tax
    expect(text).toMatch(/put protecting against drops below \$[\d,]+ costs about \$/); // hedge
    expect(text).not.toMatch(/compared after tax side by side in the tool/); // no punt
  });

  it('protective put: floor strike, cap probability, and the put-vs-collar value call', async () => {
    const text = await ask('protective_put_price', { ...VALID_ARGS.protective_put_price, protectionLevel: 0.2, volatility: 0.4, currentPrice: 200 });
    expect(text).toMatch(/floor under your value at \$|floor at \$/);
    expect(text).toMatch(/chance the stock runs past that cap/);
  });

  it('equity_funding: lists every sale date and shares, not a summary', async () => {
    const args = {
      targetAfterTax: 400000, targetDate: '2027-07-01',
      stacks: [{ ticker: 'AMZN', currentPrice: 233, lots: [{ shares: 2500, costBasisPerShare: 16, acquisitionDate: '2014-05-01' }] }],
      ordinaryIncome: 200000, filingStatus: 'married_joint', stateCode: 'CA', cashInterestRate: 0.04, riskToleranceShortfall: 0.1,
    };
    const text = await ask('equity_funding_plan', args, {}, {}, '400k by 07.2027, 2500 AMZN cost 16 bought 05.2014, MFJ CA 200k income, 233 price');
    expect(text).toMatch(/Your sell schedule, [\d,]+ shares in total/);
    // The known plan has 8 dated sales; require several explicit per-date lines.
    const bullets = (text.match(/^- \w{3} \d{4}: sell [\d,]+ shares/gm) || []).length;
    expect(bullets).toBeGreaterThanOrEqual(3);
    expect(text).not.toMatch(/in steps from .* to .*\(starting with/); // no summary punt
  });

  it('amt/iso: discloses the extra tax the exercises cost', async () => {
    const text = await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize);
    expect(text).toMatch(/add about \$[\d,]+ in tax above your normal bill/);
  });

  it('qsbs disqualified: names the specific test that is blocking', async () => {
    const args = {
      acquisitionDate: '2024-06-01', saleDate: '2026-06-01', entityType: 'us-c-corp',
      acquisitionMethod: 'original-issuance', assetCategory: 'over-75m', industry: 'tech-software',
      activeBusiness: 'yes', adjustedBasis: 0, expectedGain: 5000000, stateCode: 'CA',
      ordinaryIncome: 200000, filingStatus: 'single',
    };
    const text = await ask('qsbs_check', args, {}, {}, 'c-corp orig over75m software active 2024-06-01 sell 2026-06-01 gain 5000000 CA single 200k');
    expect(text).toMatch(/What is blocking it:/);
    expect(text).toMatch(/gross assets/i);
  });

  it('qsbs too-soon: frames it as on track, not disqualified', async () => {
    const args = {
      acquisitionDate: '2023-06-01', saleDate: '2026-12-01', entityType: 'us-c-corp',
      acquisitionMethod: 'original-issuance', assetCategory: 'under-50m', industry: 'tech-software',
      activeBusiness: 'yes', adjustedBasis: 0, expectedGain: 5000000, stateCode: 'TX',
      ordinaryIncome: 200000, filingStatus: 'single',
    };
    const text = await ask('qsbs_check', args, {}, {}, 'c-corp orig under50m software active 2023-06-01 sell 2026-12-01 gain 5000000 TX single 200k');
    expect(text).toMatch(/on track to qualify/);
    expect(text).not.toMatch(/does not appear to qualify/);
  });
});

// --- help / capability -----------------------------------------------------

describe('poe help', () => {
  it('general help lists every tool and an example', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'help' }] }, async () => ({ help: 'general' }));
    const text = await res.text();
    expect(text).toContain('Example');
    // The menu now lists required vs optional inputs per tool.
    expect(text).toMatch(/Required:/);
    expect(text).toMatch(/Optional:/);
    for (const frag of ['incentive stock option', 'non-qualified', 'restricted stock', 'concentration', 'hedge', 'QSBS', 'cash goal']) {
      expect(text).toContain(frag);
    }
  });
  it('help with a bare boolean falls back to general', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'x' }] }, async () => ({ help: true }));
    expect(await res.text()).toMatch(/Required:/);
  });
  it('tool-specific help gives that tool inputs + an example', () => {
    const t = helpText('qsbs_check');
    expect(t).toContain('qualified small business stock');
    expect(t).toContain('Example:');
    expect(t).not.toContain('incentive stock option'); // not the general menu
  });
  it('every tool help separates Required from Optional', () => {
    for (const tool of ALL_TOOLS) {
      const t = helpText(tool);
      expect(t, tool).toMatch(/Required:/);
      expect(t, tool).toMatch(/Optional:/);
    }
  });
  it('required inputs are listed; defaulted inputs show under Optional with the assumption', () => {
    const amt = helpText('amt_iso_optimize');
    expect(amt).toMatch(/Required:[^]*grant date/); // a genuine must
    expect(amt).toMatch(/Optional:[^]*assumes still employed/); // a defaulted field, demoted
    expect(amt).toMatch(/a ticker, or the current share value and an expected growth rate/); // fmv is ticker-derivable, not hard-required
    expect(amt).toMatch(/Optional:[^]*cash return rate \(assumes 4%\)/); // defaulted, not required
    const put = helpText('protective_put_price');
    expect(put).toMatch(/Required:[^]*position value/);
    expect(put).toMatch(/Optional:[^]*assumes 10%/); // protectionLevel defaulted
    const qsbs = helpText('qsbs_check');
    expect(qsbs).toMatch(/Required:[^]*entity type/);
    expect(qsbs).toMatch(/Optional: none/); // qsbs has no optional inputs
  });
});

// --- clarify / reject / fallbacks ------------------------------------------

describe('poe clarify / reject / fallback', () => {
  it('relays a clarify question verbatim', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'q' }] }, async () => ({ clarify: 'What is your filing status?' }));
    expect(await res.text()).toContain('What is your filing status?');
  });
  it('handles an off-topic rejection with fixed copy (never echoing the model sentence)', async () => {
    const res = await handleQuery(ctx(), { type: 'query', query: [{ role: 'user', content: 'q' }] }, async () => ({ reject: 'That is off topic.' }));
    const text = await res.text();
    expect(text).toContain('outside what I cover');
    expect(text).not.toContain('off topic');
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

  it('strips a fabricated growth rate the user never stated (no guessing)', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, expectedGrowth: 0.25 };
    delete a.volatility; delete (a as any).ticker;
    // Content states every input EXCEPT the fabricated 0.25 growth.
    const text = await ask('amt_iso_optimize', a, {}, {}, '20,000 ISOs, $2 strike, $200 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash return.');
    expect(text).toContain('growth rate'); // asked, did not compute on a made-up number
    expect(text).not.toContain('most money after taxes');
  });
  it('keeps growth + volatility when the user gave both, and discloses them', async () => {
    const text = await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize); // default content states 0.17 + 0.72
    expect(text).toContain('most money after taxes');
    expect(text).toContain('Assumptions:'); // discloses what it assumed
    expect(text).toContain('17%');
  });
  it('discloses ticker-derived assumptions', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, ticker: 'NVDA' };
    delete a.expectedGrowth; delete a.volatility;
    const text = await ask('amt_iso_optimize', a); // default content states fmv etc.; ticker drives growth/vol
    expect(text).toContain('Assumptions:');
    expect(text).toContain('NVDA');
  });

  it('asks plainly for a missing current price when there is no covered ticker', async () => {
    const a = { ...VALID_ARGS.equity_funding_plan };
    // No ticker (and no current price) -> cannot suggest a price -> ask.
    a.stacks = [{ lots: [{ shares: 4000, costBasisPerShare: 60, acquisitionDate: '2023-06-15' }], expectedAnnualGrowth: 0.15, volatility: 0.45 }];
    const text = await ask('equity_funding_plan', a, {}, {}, 'fund $400k from my shares, 0.15 growth 0.45 vol, bought at $60');
    expect(text).toMatch(/trading at now|current price/);
    expect(text).not.toMatch(/field "currentPrice"/);
    expect(text).not.toContain('must be a finite number');
  });

  it('cleans nested null stack fields so the ticker derives growth (was "must be a finite number")', async () => {
    const args = { targetAfterTax: 400000, targetDate: '2027-07-01', stacks: [{ ticker: 'AMZN', currentPrice: null, expectedAnnualGrowth: null, volatility: null, lots: [{ shares: 250, costBasisPerShare: 16, acquisitionDate: '2014-05-01' }] }], ordinaryIncome: 200000, filingStatus: 'married_joint', stateCode: 'CA' };
    const text = await ask('equity_funding_plan', args, {}, {}, 'cash goal 400k by 07.2027, 250 AMZN cost basis 16 bought 05.2014, MFJ CA 200k');
    // The point of this test: null stack fields are cleaned so the ticker drives
    // the numbers and a real plan computes (not "must be a finite number"). The
    // derived AMZN price is disclosed and a sell schedule is produced. (250 small
    // shares can't reach $400k, so this is correctly an infeasible plan, not the
    // "most expected wealth" success path — that proxy used to mask defect P1.)
    expect(text).toMatch(/Using AMZN at \$/);
    expect(text).toMatch(/sell [\d,]+ shares/);
    expect(text).not.toContain('must be a finite number');
  });

  it('suggests the current price from a ticker (covered), disclosed', async () => {
    const a = { shares: 10000, strike: 2, ticker: 'NVDA', filingStatus: 'married_joint', ordinaryIncome: 300000, stateCode: 'CA', horizon: 4, cashReturnRate: 0.05, grantDate: '2022-01-01' };
    const text = await ask('amt_iso_optimize', a, {}, {}, '10,000 NVDA ISOs granted in 2022, $2 strike, 300k income, MFJ, CA, 4yr, 5% cash');
    expect(text).toContain('most money after taxes'); // computed, did not ask
    expect(text).toMatch(/Using NVDA at \$/); // price disclosed
  });

  it('equity_funding: ignores a model-hallucinated past `today`, anchors the schedule to the real date', async () => {
    // The extractor model (training cutoff in the past) can emit `today` as its
    // stale sense of "now"; the parser would anchor the whole schedule there,
    // producing sell dates BEFORE the real current date. The server clock must win.
    const args = {
      today: '2023-10-01',
      targetAfterTax: 400000, targetDate: '2027-07-01',
      stacks: [{ ticker: 'AMZN', currentPrice: 233, lots: [{ shares: 2500, costBasisPerShare: 16, acquisitionDate: '2014-05-01' }] }],
      ordinaryIncome: 200000, filingStatus: 'married_joint', stateCode: 'CA', cashInterestRate: 0.04, riskToleranceShortfall: 0.02,
    };
    const text = await ask('equity_funding_plan', args, {}, {}, '400k by 07.2027, 2500 AMZN cost 16 bought 05.2014, MFJ CA 200k income, 233 price, 2% shortfall');
    const saleYears = [...text.matchAll(/^- \w{3} (\d{4}): sell/gm)].map((m) => Number(m[1]));
    expect(saleYears.length).toBeGreaterThan(0);
    const currentYear = new Date().getUTCFullYear();
    expect(Math.min(...saleYears)).toBeGreaterThanOrEqual(currentYear); // no sales in the past
  });

  it('never values equity_funding at the cost basis: drops it, then suggests the real price', async () => {
    const args = { targetAfterTax: 400000, targetDate: '2028-06-01', stacks: [{ ticker: 'NVDA', currentPrice: 60, expectedAnnualGrowth: 0.15, volatility: 0.45, lots: [{ shares: 4000, costBasisPerShare: 60, acquisitionDate: '2023-06-15' }] }], ordinaryIncome: 280000, filingStatus: 'married_joint', stateCode: 'CA', cashInterestRate: 0.04, riskToleranceShortfall: 0.1 };
    const text = await ask('equity_funding_plan', args, {}, {}, 'fund 400k from 4000 NVDA bought at $60');
    // The $60 cost basis is dropped; the snapshot price is used and disclosed.
    expect(text).toMatch(/leaves the most expected wealth/);
    expect(text).toMatch(/Using NVDA at \$/);
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

describe('poe battery fixes (2026-07-03): humanized asks, date normalization, rsu hold default', () => {
  it('malformed grantDate asks in plain words, never "ISO date string"', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, grantDate: 'unknown' };
    const text = await ask('amt_iso_optimize', a);
    expect(text).toContain('when the options were granted');
    expect(text).not.toContain('ISO date string');
    expect(text).not.toMatch(/field "grantDate"/);
  });

  it('missing acquisitionDate on concentration asks in plain words', async () => {
    const a = { ...VALID_ARGS.concentration_analyze };
    delete a.acquisitionDate;
    const text = await ask('concentration_analyze', a);
    expect(text).toContain('when you acquired the shares');
    expect(text).not.toMatch(/field "acquisitionDate"/);
  });

  it('past targetDate asks for a future deadline, no raw hint or double period', async () => {
    const a = { ...VALID_ARGS.equity_funding_plan, targetDate: '2020-01-01' };
    const text = await ask('equity_funding_plan', a);
    expect(text).toContain('future date');
    expect(text).not.toContain('deadline is in the past');
    expect(text).not.toContain('..');
  });

  it('NUMERIC year grantDate (2023) normalizes and computes (p.date requires a string)', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, grantDate: 2023 };
    const text = await ask('amt_iso_optimize', a);
    expect(text).toContain('most money after taxes');
  });

  it('numeric lot acquisitionDate normalizes inside stacks and computes', async () => {
    const a = JSON.parse(JSON.stringify(VALID_ARGS.equity_funding_plan));
    a.stacks[0].lots[0].acquisitionDate = 2023;
    const text = await ask('equity_funding_plan', a);
    expect(text).toContain('sell');
  });

  it('year-only targetDate pins to year END, not January (deadline direction)', async () => {
    const year = new Date().getUTCFullYear();
    const a = JSON.parse(JSON.stringify(VALID_ARGS.equity_funding_plan));
    a.targetDate = String(year); // "end of <this year>" mid-year: Jan 1 would be past
    const text = await ask('equity_funding_plan', a);
    expect(text).not.toContain('future date');
    expect(text).toMatch(/sell|expected wealth/);
  });

  it('boolean field emitted as "yes" coerces instead of asking a garbled question', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, hasLeftCompany: 'no' };
    const text = await ask('amt_iso_optimize', a);
    expect(text).toContain('most money after taxes');
    expect(text).not.toContain('Tell me your whether');
  });

  it('malformed lot vestDate asks in plain words (nested field, no raw leak)', async () => {
    const a = JSON.parse(JSON.stringify(VALID_ARGS.equity_funding_plan));
    a.stacks[0].lots[0].vestDate = 'unknown';
    const text = await ask('equity_funding_plan', a);
    expect(text).not.toMatch(/field "vestDate"/);
  });

  it('an explicit short hold (2 months) is not silently overridden to 1 year', async () => {
    const a = { ...VALID_ARGS.rsu_sell_vs_hold, holdYears: 0.167 };
    const text = await ask('rsu_sell_vs_hold', a);
    expect(text).not.toContain('1-year hold');
  });

  it('rsu "sell at vest or hold" with holdYears 0 computes on the disclosed 1-year default', async () => {
    const a = { ...VALID_ARGS.rsu_sell_vs_hold, holdYears: 0 };
    const text = await ask('rsu_sell_vs_hold', a);
    expect(text).not.toMatch(/holdYears/);
    expect(text).toContain('Assumptions:');
    expect(text).toContain('1-year hold');
  });

  it('rsu with no holdYears at all computes on the same default', async () => {
    const a = { ...VALID_ARGS.rsu_sell_vs_hold };
    delete a.holdYears;
    const text = await ask('rsu_sell_vs_hold', a);
    expect(text).toContain('1-year hold');
  });

  it('extractor prompt anchors relative dates to the real current date', () => {
    const prompt = extractorPrompt('User: need cash by next summer');
    expect(prompt).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`);
    expect(prompt).toContain('never emit a deadline in the past');
  });

  it('extractor prompt demands one bundled clarify question', () => {
    const prompt = extractorPrompt('User: hi');
    expect(prompt).toContain('EVERYTHING you need');
  });
});

describe('poe anti-fabrication scoped to user turns (2026-07-04)', () => {
  it('a growth rate appearing only in a BOT turn (the intro example) is not user-stated', async () => {
    // The greeting embeds "12% growth"; the extractor copies it. The guard
    // must strip it because the USER never said 12%.
    const a = { ...VALID_ARGS.amt_iso_optimize, expectedGrowth: 0.12 };
    delete a.volatility;
    const res = await handleQuery(
      ctx({}),
      { type: 'query', query: [
        { role: 'bot', content: 'Example: 10,000 ISOs, granted 2022-01-01, 5% cash, 12% growth. Best schedule?' },
        { role: 'user', content: 'I have 20000 ISOs, $2 strike, $200 value, married joint, $300k income, CA, 4 years, granted 2022-01-01, 0.055 cash return' },
      ] } as any,
      async () => ({ tool: 'amt_iso_optimize', args: a }),
    );
    const text = sseText(await res.text());
    expect(text).toContain('growth');
    expect(text).not.toContain('most money after taxes');
  });

  it('an invented grantDate (no date wording in user text) is stripped and asked for', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize };
    const text = await ask('amt_iso_optimize', a, {}, {},
      '20,000 ISOs, $2 strike, $200 value, 17% growth, 0.72 vol, married joint, $300k income, CA, 4 year horizon, 0.055 cash return');
    expect(text).toContain('when the options were granted');
    expect(text).not.toContain('most money after taxes');
  });

  it('a stated grant year keeps the extractor-resolved grantDate', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize };
    const text = await ask('amt_iso_optimize', a, {}, {},
      '20,000 ISOs granted in 2022, $2 strike, $200 value, 17% growth, 0.72 vol, married joint, $300k income, CA, 4 year horizon, 0.055 cash return');
    expect(text).toContain('most money after taxes');
  });

  it('a non-object args payload gets the friendly could-not-read reply, not a JSON error', async () => {
    const text = await ask('concentration_analyze', 'garbage' as any);
    expect(text).not.toMatch(/JSON object/);
    expect(text).toContain('could not read');
  });

  it('the reject lead-in is fixed copy, never the model sentence (which can garble)', async () => {
    const res = await handleQuery(
      ctx({}),
      { type: 'query', query: [{ role: 'user', content: 'what is the weather' }] } as any,
      async () => ({ reject: 'This chat is about equity compensation tax planning.' }),
    );
    const text = sseText(await res.text());
    expect(text).toContain('That is outside what I cover.');
    expect(text).not.toContain('This chat is about equity compensation tax planning.');
  });

  it('extractor prompt carries the assetCategory threshold mapping', () => {
    const prompt = extractorPrompt('User: founder stock, $8M in assets');
    expect(prompt).toContain('"under-50m"');
    expect(prompt).toContain('Never confuse the expected GAIN');
  });
});

describe('poe round-4 fixes: stack tickers, uncovered symbols, bundled grant ask', () => {
  it('a placeholder ticker inside stacks is dropped; explicit growth/vol still compute', async () => {
    const a = JSON.parse(JSON.stringify(VALID_ARGS.equity_funding_plan));
    a.stacks[0].ticker = 'unknown';
    const text = await ask('equity_funding_plan', a);
    expect(text).not.toContain('trailing-returns');
    expect(text).toMatch(/sell|expected wealth/);
  });

  it('an uncovered real-format ticker asks in plain words, no table/field leak', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, ticker: 'ZZZZ' };
    delete a.expectedGrowth; delete a.volatility;
    const text = await ask('amt_iso_optimize', a);
    expect(text).not.toContain('trailing-returns table');
    expect(text).not.toContain('Pass "expectedAnnualGrowth"');
    expect(text).toMatch(/covered public ticker|growth rate/);
  });

  it('the ISO growth ask bundles the grant-year question when grantDate is also missing', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize };
    delete a.expectedGrowth; delete a.volatility; delete a.grantDate;
    const text = await ask('amt_iso_optimize', a);
    expect(text).toContain('ticker');
    expect(text).toContain('granted');
  });
});

describe('poe ticker fabrication guard (2026-07-04 r4 grader FAIL)', () => {
  it('a stack ticker the user never said is stripped; the plan computes flat-price with disclosure', async () => {
    const a = JSON.parse(JSON.stringify(VALID_ARGS.equity_funding_plan));
    delete a.stacks[0].expectedAnnualGrowth; delete a.stacks[0].volatility;
    // a.stacks[0].ticker stays NVDA, but the user text never mentions it
    const text = await ask('equity_funding_plan', a, {}, {},
      'I need $400,000 after tax by 2028-06-01 from 4,000 shares of my company stock at $140, basis $60, bought 2023-06-15. Married joint, $280k income, CA.');
    expect(text).not.toMatch(/NVDA/); // the fabricated ticker never surfaces
    expect(text).toContain('flat stock price'); // conservative default disclosed
  });

  it('a lowercase user-stated ticker is kept (nvda follow-up path)', async () => {
    const a = JSON.parse(JSON.stringify(VALID_ARGS.equity_funding_plan));
    delete a.stacks[0].expectedAnnualGrowth; delete a.stacks[0].volatility;
    const text = await ask('equity_funding_plan', a, {}, {},
      'I need $400,000 after tax by 2028-06-01 from 4,000 nvda at $140, basis $60, bought 2023-06-15. Married joint, $280k income, CA.');
    expect(text).toMatch(/sell|expected wealth/);
  });

  it('a top-level fabricated ticker is stripped for amt too', async () => {
    const a = { ...VALID_ARGS.amt_iso_optimize, ticker: 'NVDA' };
    delete a.expectedGrowth; delete a.volatility;
    const text = await ask('amt_iso_optimize', a, {}, {},
      '20,000 ISOs granted in 2022, $2 strike, $200 value, married joint, $300k income, CA, 4 year horizon, 0.055 cash return');
    expect(text).not.toContain('most money after taxes');
    expect(text).toContain('ticker');
  });

  it('remaining shares are labeled at the projected target-date price, not today', async () => {
    const text = await ask('equity_funding_plan', VALID_ARGS.equity_funding_plan, {}, {},
      "my details: 400000 2028-06-01 NVDA 140 0.15 0.45 4000 60 2023-06-15 280000 0.04 0.1");
    expect(text).not.toContain("at today's price");
  });

  it('equity_funding assumptions name the stack ticker actually used', async () => {
    const text = await ask('equity_funding_plan', VALID_ARGS.equity_funding_plan, {}, {},
      "my details: 400000 2028-06-01 NVDA 140 0.15 0.45 4000 60 2023-06-15 280000 0.04 0.1");
    expect(text).toMatch(/Assumptions:.*NVDA/s);
  });
});

describe('poe r5 WARN fixes: qsbs cleared tests + clarify funnel link', () => {
  it('a qualifying QSBS verdict names the tests it cleared', async () => {
    const text = await ask('qsbs_check', VALID_ARGS.qsbs_check);
    expect(text).toMatch(/Clears \d of \d statutory tests/);
    expect(text.toLowerCase()).toContain('c-corporation');
  });

  it('an extractor clarify carries the free-tools pointer', async () => {
    const res = await handleQuery(
      ctx({}),
      { type: 'query', query: [{ role: 'user', content: 'help with my options' }] } as any,
      async () => ({ clarify: 'How many shares, and what is the strike?' }),
    );
    const text = sseText(await res.text());
    expect(text).toContain('How many shares');
    expect(text).toContain('optionsahoy.com/tools');
  });
});

describe('poe pricing', () => {
  it('helpers default to $0.30 and honor the free window', () => {
    expect(priceMilliCents({})).toBe(30000);
    expect(priceUsd({})).toBe('$0.30');
    expect(pricingActive({ POE_FREE_UNTIL: '2099-01-01' })).toBe(false);
    expect(pricingActive({ POE_FREE_UNTIL: '2020-01-01' })).toBe(true);
    expect(pricingActive({ POE_FREE_UNTIL: '2020-01-01', POE_PRICE_MILLI_CENTS: '0' })).toBe(false);
  });
  it('free period: answer links the free tool', async () => {
    const text = await ask('amt_iso_optimize', VALID_ARGS.amt_iso_optimize, FREE_ENV);
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
  it('extractorPrompt tells the model a ticker is sufficient and to carry fields across turns', () => {
    // Guards against the multi-turn drift where a tweak turn ("2% shortfall risk")
    // dropped the ticker / re-asked for growth, changing the trade-off figures.
    const p = extractorPrompt('q');
    expect(p).toMatch(/TICKER IS SUFFICIENT/);
    expect(p).toMatch(/equity_funding/);
    expect(p).toMatch(/KEEP every field already established/);
  });
  it('toolSpec exposes required fields, enum values, and an example per tool', () => {
    const spec = toolSpec();
    expect(spec).toContain('filingStatus=[single|married_joint|head_household]');
    expect(spec).toContain('sector=[tech_software'); // concentration / protective put enum
    expect(spec).toContain('Example args:');
    for (const t of ALL_TOOLS) expect(spec).toContain(t);
  });
});
