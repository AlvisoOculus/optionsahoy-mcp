// AlphaLatitude Inc. © 2026
// Live end-to-end smoke against the production MCP endpoint: initialize,
// tools/list, resources/list, prompts/list, then tools/call for every tool
// with known-valid payloads (mirrors the /for-agents try-it bodies).
//
// CALLS must cover every name in tools/list, and the script asserts that
// rather than a hardcoded count: shipping a tool without a live payload then
// fails here instead of going unsmoked (rsu_lot_optimize did, from #174 until
// 2026-08-01).
// Usage: node scripts/e2e-live.mjs [base-url]   (default https://optionsahoy.com/mcp)

const BASE = process.argv[2] ?? 'https://optionsahoy.com/mcp';

const CALLS = {
  amt_iso_optimize: {
    shares: 8000, strike: 5, fmv: 40, horizon: 5, ticker: 'NVDA',
    expectedSalePrice: 80, ordinaryIncome: 200000, filingStatus: 'single',
    stateCode: 'CA', stillEmployed: true, hasLeftCompany: false,
    grantDate: '2024-01-15', carryforwardCredit: 0, cashReturnRate: 0.05,
  },
  nso_calculate: {
    shares: 5000, strike: 8, currentPrice: 75, expectedSalePrice: 90,
    holdYears: 1, ordinaryIncome: 250000, filingStatus: 'single',
    stateCode: 'CA', stillEmployed: true, volatility: 0.3,
    expectedMarketReturn: 0.07, holdFunding: 'sell-to-cover',
  },
  rsu_sell_vs_hold: {
    shares: 1000, currentPrice: 200, expectedSalePrice: 220, holdYears: 1.5,
    ordinaryIncome: 300000, filingStatus: 'married_joint', stateCode: 'NY',
    stillEmployed: true, volatility: 0.25, expectedMarketReturn: 0.07,
  },
  concentration_analyze: {
    ticker: 'NVDA', positionValue: 750000, costBasis: 150000,
    acquisitionDate: '2022-01-15', sector: 'tech_software',
    totalAssets: 2250000, ordinaryIncome: 350000, filingStatus: 'single',
    stateCode: 'CA',
  },
  protective_put_price: {
    positionValue: 500000, sector: 'tech_software', volatility: 0.35,
    protectionLevel: 0.2, tenorYears: 1,
  },
  qsbs_check: {
    acquisitionDate: '2020-03-01', saleDate: '2026-03-15',
    entityType: 'us-c-corp', acquisitionMethod: 'original-issuance',
    assetCategory: 'under-50m', industry: 'tech-software',
    activeBusiness: 'yes', adjustedBasis: 50000, expectedGain: 5000000,
    stateCode: 'CA', ordinaryIncome: 300000, filingStatus: 'single',
  },
  equity_funding_plan: {
    targetAfterTax: 400000, targetDate: '2029-06-06',
    stacks: [{ ticker: 'NVDA', currentPrice: 120, lots: [
      { shares: 2000, costBasisPerShare: 50, acquisitionDate: '2022-01-15' },
    ] }],
    ordinaryIncome: 350000, filingStatus: 'single', stateCode: 'CA',
  },
  rsu_lot_optimize: {
    lots: [
      { vestDate: '2022-08-15', shares: 120, costBasisPerShare: 95 },
      { vestDate: '2024-02-15', shares: 100, costBasisPerShare: 130 },
      { vestDate: '2026-05-15', shares: 80, costBasisPerShare: 210 },
    ],
    currentPrice: 180, divestFraction: 0.5, horizonYears: 2,
    ordinaryIncome: 200000, filingStatus: 'single', stateCode: 'CA',
  },
};

let id = 0;
const sessionId = `e2e-${Date.now()}`;
let failures = 0;

async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: JSON-RPC error ${json.error.code} ${json.error.message}`);
  return json.result;
}

function check(label, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'oa-e2e-live', version: '1.0' },
});
check('initialize', init.serverInfo?.name === 'OptionsAhoy', `serverInfo=${JSON.stringify(init.serverInfo)}`);

const tools = (await rpc('tools/list', {})).tools;
check('tools/list has 8 tools', tools.length === 8, tools.map((t) => t.name).join(','));
check(
  'tools/list: every tool has an outputSchema (type object)',
  tools.every((t) => t.outputSchema?.type === 'object'),
  tools.filter((t) => t.outputSchema?.type !== 'object').map((t) => t.name).join(',') || 'all present',
);

const missingPayloads = tools.map((t) => t.name).filter((n) => !(n in CALLS));
check(
  'every tool in tools/list has a live payload here',
  missingPayloads.length === 0,
  missingPayloads.length ? `no CALLS entry for: ${missingPayloads.join(',')}` : 'all covered',
);

const resources = (await rpc('resources/list', {})).resources;
check('resources/list has 8 resources', resources.length === 8, `got ${resources.length}`);

const prompts = (await rpc('prompts/list', {})).prompts;
check('prompts/list has 8 prompts', prompts.length === 8, `got ${prompts.length}`);

for (const [name, args] of Object.entries(CALLS)) {
  const t0 = Date.now();
  try {
    const result = await rpc('tools/call', { name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    check(
      `tools/call ${name}`,
      !result.isError && text.length > 50 && typeof parsed === 'object',
      `${Date.now() - t0}ms, ${text.length} bytes`,
    );
    check(
      `tools/call ${name} returns structuredContent matching the text block`,
      result.structuredContent !== undefined &&
        typeof result.structuredContent === 'object' &&
        JSON.stringify(result.structuredContent) === text,
    );
  } catch (err) {
    check(`tools/call ${name}`, false, String(err));
  }
}

// --- new-feature checks (funnel P1/P2, 2026-08) -----------------------------
// Every non-MCP fetch self-identifies as oa-e2e-live via User-Agent so the
// stats classifier files these as smoke, not real traffic.
const ORIGIN = new URL(BASE).origin;
const SMOKE_UA = { 'user-agent': 'oa-e2e-live' };

// Session issuance: the server MUST mint an id when none is supplied, and
// echo a client-supplied one. This is what arms the _meta funnel.
{
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'oa-e2e-live', version: '1.0' } } }),
  });
  const minted = res.headers.get('mcp-session-id');
  check('session: initialize mints an id when none supplied', !!minted && minted.length >= 16, `got ${minted}`);
  check('session: expose-headers lets browsers read it', /mcp-session-id/i.test(res.headers.get('access-control-expose-headers') ?? ''));
  const res2 = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'e2e-echo-check' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'oa-e2e-live', version: '1.0' } } }),
  });
  check('session: client-supplied id is echoed, not replaced', res2.headers.get('mcp-session-id') === 'e2e-echo-check');
}

// HEAD /mcp: health checkers get 200, not a bad-method error.
{
  const res = await fetch(BASE, { method: 'HEAD' });
  check('HEAD /mcp returns 200', res.status === 200);
}

// _meta.optionsahoy funnel: full block + s= join token on the first call in a
// fresh session, deduped bare form on the second. Session id keeps the e2e-
// prefix so the funnel rollups exclude it as smoke.
{
  const metaSession = `e2e-meta-${Date.now()}`;
  const joinPrefix = metaSession.slice(0, 8); // 'e2e-meta'
  const callQsbs = async () => {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': metaSession },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'qsbs_check', arguments: CALLS.qsbs_check } }),
    });
    return (await res.json()).result?.structuredContent?._meta?.optionsahoy;
  };
  const first = await callQsbs();
  check('_meta funnel: first call carries free_tool + also_run + beta', !!first?.free_tool && !!first?.also_run && !!first?.beta, JSON.stringify(first ?? null)?.slice(0, 120));
  check('_meta funnel: join token rides free_tool and beta', (first?.free_tool ?? '').endsWith(`&s=${joinPrefix}`) && (first?.beta ?? '').endsWith(`&s=${joinPrefix}`), `free_tool tail: ${(first?.free_tool ?? '').slice(-30)}`);
  const second = await callQsbs();
  check('_meta funnel: second call in session dedupes the beta pitch', !!second?.free_tool && second?.beta === undefined, JSON.stringify(second ?? null)?.slice(0, 120));
}

// REST next_steps envelope + tolerant numeric reader, live.
{
  const res = await fetch(`${ORIGIN}/api/v1/nso`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...SMOKE_UA },
    body: JSON.stringify({ ...CALLS.nso_calculate, ordinaryIncome: '$250,000' }),
  });
  const body = await res.json();
  check('REST: quoted "$250,000" coerces and computes', res.status === 200 && body.ok === true);
  check('REST: success carries next_steps (web_tool/also_run/beta)', !!body.next_steps?.web_tool && Array.isArray(body.next_steps?.also_run) && !!body.next_steps?.beta, JSON.stringify(body.next_steps ?? null)?.slice(0, 100));
  const err = await fetch(`${ORIGIN}/api/v1/nso`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...SMOKE_UA },
    body: JSON.stringify({ shares: 'not a number' }),
  });
  const errBody = await err.json();
  check('REST: errors stay bare (no next_steps) and name the field', err.status === 400 && errBody.next_steps === undefined && /finite number/.test(errBody.error ?? ''), errBody.error);
}

// GET /api/v1 index links.
{
  const idx = await (await fetch(`${ORIGIN}/api/v1`, { headers: SMOKE_UA })).json();
  check(
    'GET /api/v1: calculator endpoints carry a derived web_tool; non-calculators none',
    Array.isArray(idx.endpoints) &&
      idx.endpoints.every((e) =>
        e.method === 'POST'
          ? typeof e.web_tool === 'string' && e.web_tool.includes(e.path.replace('/api/v1/', '/tools/'))
          : e.web_tool === undefined,
      ),
    `${idx.endpoints?.length ?? 0} endpoints`,
  );
  check('GET /api/v1: top-level tools/try_it/beta links present', !!idx.tools && !!idx.try_it && !!idx.beta);
}

// A2A: routing, legacy task lifecycle, conversational fallback.
{
  const a2a = async (method, params) => {
    const res = await fetch(`${ORIGIN}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SMOKE_UA },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return res.json();
  };
  const routed = await a2a('message/send', { message: { parts: [{ kind: 'text', text: 'Should I sell my RSUs?' }] } });
  check('A2A: free text routes to rsu_sell_vs_hold', (routed.result?.parts?.[0]?.text ?? '').includes('rsu_sell_vs_hold'));

  const task = await a2a('tasks/send', { id: 'e2e-task-1', message: { parts: [{ kind: 'data', data: { skill: 'qsbs_check', input: CALLS.qsbs_check } }] } });
  check('A2A: legacy tasks/send returns a completed Task with artifacts', task.result?.id === 'e2e-task-1' && task.result?.status?.state === 'completed' && Array.isArray(task.result?.artifacts?.[0]?.parts), JSON.stringify(task.result?.status ?? task.error ?? null));

  const got = await a2a('tasks/get', { id: 'e2e-task-1' });
  check('A2A: tasks/get returns -32001 with guidance', got.error?.code === -32001 && /synchronously/.test(got.error?.message ?? ''));

  const convo = await a2a('message/send', { message: { parts: [{ kind: 'text', text: 'Hello! I would love to collaborate with your agent.' }] } });
  check('A2A: conversational message gets the capabilities reply', (convo.result?.parts?.[0]?.text ?? '').includes('deterministic calculator agent'));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
