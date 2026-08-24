// AlphaLatitude Inc. © 2026
//
// Run a single-stock concentration analysis via the MCP. Demonstrates
// the ticker-based input path: pass `ticker: "NVDA"` and the optimizer
// resolves the implied vol (as of the last market close) and the trailing
// return for you.
//
//   node call-concentration.mjs

const MCP_URL = 'https://optionsahoy.com/mcp';

const args = {
  ticker: 'NVDA',
  positionValue: 750_000,
  netWorthExclPosition: 1_500_000,
  costBasis: 150_000,
  holdingPeriod: 'longTerm',
  filingStatus: 'single',
  stateCode: 'CA',
  ordinaryIncome: 350_000,
};

const response = await fetch(MCP_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'concentration_analyze', arguments: args },
  }),
});

const json = await response.json();
const result = JSON.parse(json.result?.content?.[0]?.text ?? '{}');

console.log(`\nConcentration analysis for $${args.positionValue.toLocaleString()} of ${args.ticker}\n`);
console.log(JSON.stringify(result, null, 2));
