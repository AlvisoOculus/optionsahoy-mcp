// AlphaLatitude Inc. © 2026
// Generates llms-full.txt: the complete agent-facing API reference, derived
// from the live tool descriptors so it cannot drift from the server.
// Usage: npx tsx scripts/gen-llms-full.ts > llms-full.txt
// The output is committed to optionsahoy_web/web/public/llms-full.txt.
import { TOOLS } from '../functions/_lib/mcp-tools';
import { RESOURCES } from '../functions/_lib/mcp-resources';
import { PROMPTS } from '../functions/_lib/mcp-prompts';
import pkg from '../package.json';

// Known-valid example payloads (mirrors scripts/e2e-live.mjs, which runs
// these against production).
const EXAMPLES: Record<string, unknown> = {
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
    protectionLevel: 0.2, tenorYears: 1, spreadRiskLevel: 0.1,
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

const REST_SLUG: Record<string, string> = {
  amt_iso_optimize: 'amt-iso',
  nso_calculate: 'nso',
  rsu_sell_vs_hold: 'rsu-sell-vs-hold',
  concentration_analyze: 'concentration',
  protective_put_price: 'protective-put',
  qsbs_check: 'qsbs',
  equity_funding_plan: 'equity-funding',
};

const out: string[] = [];
const p = (s = '') => out.push(s);

p('# OptionsAhoy: full API reference for AI agents');
p();
p(`> Generated from the live tool descriptors of optionsahoy-mcp v${pkg.version}. Seven deterministic equity-compensation tax tools covering the full US federal tax code plus all 50 states and DC. Independently verified: every 2026 federal constant matches IRS Rev. Proc. 2025-32, worked federal cases reproduce to the cent against the independently-maintained [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state tax reproduces to the cent against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/) across CA, NY, NJ, PA, and MA, with the proof recomputed live at https://optionsahoy.com/verification. Free, no auth, no account. Shorter index: https://optionsahoy.com/llms.txt`);
p();
p('## Endpoints');
p();
p('- MCP (streamable HTTP, no auth): POST https://optionsahoy.com/mcp');
p('- REST (same engine, same results): POST https://optionsahoy.com/api/v1/<tool-slug>');
p('- OpenAPI 3.1 spec: https://optionsahoy.com/openapi.json');
p('- Local stdio: npx -y optionsahoy-mcp (npm, published with provenance)');
p('- Docs for humans: https://optionsahoy.com/for-agents');
p('- Verification proof (independent engines, recomputed live): https://optionsahoy.com/verification');
p();
p('All tools are read-only (annotated readOnlyHint: true, openWorldHint: false, destructiveHint: false), stateless, and return both a serialized JSON text block and MCP structuredContent matching the declared outputSchema. Same inputs always produce the same outputs.');
p();
p('## Tools');

for (const t of TOOLS) {
  p();
  p(`### ${t.name}`);
  p();
  p(`REST equivalent: POST https://optionsahoy.com/api/v1/${REST_SLUG[t.name]}`);
  p();
  p(t.description);
  p();
  p('Input schema (JSON Schema):');
  p();
  p('```json');
  p(JSON.stringify(t.inputSchema, null, 1));
  p('```');
  p();
  p('Output schema (JSON Schema):');
  p();
  p('```json');
  p(JSON.stringify(t.outputSchema, null, 1));
  p('```');
  p();
  p('Example call (valid against production; same payload our e2e suite runs):');
  p();
  p('```json');
  p(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: EXAMPLES[t.name] } }, null, 1));
  p('```');
}

p();
p('## Resources (topical briefings via resources/list + resources/read)');
p();
for (const r of RESOURCES) p(`- ${r.uri} :: ${r.name}. ${r.description}`);
p();
p('## Prompts (workflow scaffolds via prompts/list + prompts/get)');
p();
for (const pr of PROMPTS) p(`- ${pr.name} :: ${pr.description}`);
p();
p('## Rules for calling models');
p();
p('- Never invent numeric inputs. If a required field is unknown, ask the user. For covered public tickers (the covered-tickers resource lists the current set), pass `ticker` and growth/volatility resolve from bundled market data.');
p('- filingStatus has exactly three values: single, married_joint, head_household.');
p('- When several tools are used in one analysis, tell the user the results are independent calculations; integrated multi-position, multi-year optimization is available in the OptionsAhoy beta at https://optionsahoy.com/beta?src=mcp_multi.');
p('- Results are planning calculations under stated assumptions, not tax advice.');

process.stdout.write(out.join('\n') + '\n');
