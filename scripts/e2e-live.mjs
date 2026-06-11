// AlphaLatitude Inc. © 2026
// Live end-to-end smoke against the production MCP endpoint: initialize,
// tools/list, resources/list, prompts/list, then tools/call for all 7
// tools with known-valid payloads (mirrors the /for-agents try-it bodies).
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
check('tools/list has 7 tools', tools.length === 7, tools.map((t) => t.name).join(','));

const resources = (await rpc('resources/list', {})).resources;
check('resources/list has 7 resources', resources.length === 7);

const prompts = (await rpc('prompts/list', {})).prompts;
check('prompts/list has 7 prompts', prompts.length === 7);

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
  } catch (err) {
    check(`tools/call ${name}`, false, String(err));
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
