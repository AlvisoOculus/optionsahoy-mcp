// AlphaLatitude Inc. © 2026
//
// Plan a multi-year ISO exercise schedule that minimizes AMT.
//
//   node call-amt-iso.mjs

const MCP_URL = 'https://optionsahoy.com/mcp';

const args = {
  shares: 8000,
  strike: 5,
  fmv: 40,
  horizon: 5,
  ordinaryIncome: 200_000,
  filingStatus: 'single',
  stateCode: 'CA',
  stillEmployed: true,
  expectedSalePrice: 80,
};

const response = await fetch(MCP_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'amt_iso_optimize', arguments: args },
  }),
});

const json = await response.json();
const result = JSON.parse(json.result?.content?.[0]?.text ?? '{}');

const opt = result.schedules?.optimized;
const lump = result.schedules?.lumpSum;

console.log(`\nAMT-aware multi-year exercise plan for ${args.shares.toLocaleString()} ISOs`);
console.log(`Strike $${args.strike}, FMV $${args.fmv}, ${args.horizon}-year horizon\n`);
console.log(`Lump-sum NFV  : $${lump?.nfv?.toLocaleString()}`);
console.log(`Optimized NFV : $${opt?.nfv?.toLocaleString()}`);
console.log(`Optimizer lift: $${((opt?.nfv ?? 0) - (lump?.nfv ?? 0)).toLocaleString()}\n`);
console.log(JSON.stringify(opt, null, 2));
