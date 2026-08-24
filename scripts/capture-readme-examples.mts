// AlphaLatitude Inc. © 2026
//
// Captures the worked examples quoted in README.md ("What a call looks like")
// straight from production, one JSON file per tool under docs/examples/.
// Every figure in that README section must appear in the matching capture;
// tests/readme-worked-examples.test.ts enforces it.
//
// Usage: npx tsx scripts/capture-readme-examples.mts
//
// The argument sets below are the committed, reproducible inputs. They are
// deliberately EXPLICIT (no `ticker` shortcut, every date pinned) so a reader
// re-running this gets the same numbers instead of whatever the market did
// this morning. The ISO case is the site's published 50,000-share worked
// example (optionsahoy.com/learn/amt-crossover#worked-example).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ENDPOINT = process.env.OA_ENDPOINT || 'https://optionsahoy.com/mcp';
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'examples');

export const EXAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  amt_iso_optimize: {
    shares: 50000, strike: 4, fmv: 90, horizon: 4,
    expectedGrowth: 0.1, volatilityDrag: 0.2, cashReturnRate: 0.05,
    filingStatus: 'married_joint', ordinaryIncome: 300000, stateCode: 'CA',
    carryforwardCredit: 0, grantDate: '2023-03-15', hasLeftCompany: false,
    terminationDate: null,
  },
  nso_calculate: {
    shares: 5000, strike: 8, currentPrice: 75, expectedSalePrice: 90,
    holdYears: 1, holdFunding: 'sell-to-cover', volatility: 0.3,
    expectedMarketReturn: 0.07, ordinaryIncome: 250000, filingStatus: 'single',
    stateCode: 'CA', stillEmployed: true,
  },
  rsu_sell_vs_hold: {
    shares: 1000, currentPrice: 200, expectedSalePrice: 220, holdYears: 1.5,
    volatility: 0.25, expectedMarketReturn: 0.07, ordinaryIncome: 300000,
    filingStatus: 'married_joint', stateCode: 'NY', stillEmployed: true,
  },
  concentration_analyze: {
    positionValue: 750000, costBasis: 150000, acquisitionDate: '2022-01-15',
    sector: 'tech_software', totalAssets: 2250000, expectedPositionReturn: 0.12,
    expectedMarketReturn: 0.07, volatility: 0.35, volatilityDrag: 0.2,
    ordinaryIncome: 350000, filingStatus: 'single', stateCode: 'CA',
  },
  protective_put_price: {
    positionValue: 500000, sector: 'tech_software', volatility: 0.35,
    protectionLevel: 0.2, tenorYears: 1, spreadRiskLevel: 0.1,
    expectedReturn: 0.08,
  },
  qsbs_check: {
    acquisitionDate: '2020-03-01', saleDate: '2026-03-15',
    entityType: 'us-c-corp', acquisitionMethod: 'original-issuance',
    assetCategory: 'under-50m', industry: 'tech-software', activeBusiness: 'yes',
    adjustedBasis: 50000, expectedGain: 5000000, stateCode: 'CA',
    ordinaryIncome: 300000, filingStatus: 'single',
  },
  equity_funding_plan: {
    targetAfterTax: 400000, targetDate: '2029-06-30',
    stacks: [{
      currentPrice: 120, expectedAnnualGrowth: 0.08, volatility: 0.4,
      lots: [
        { shares: 2000, costBasisPerShare: 50, acquisitionDate: '2022-01-15' },
        { shares: 1500, costBasisPerShare: 95, acquisitionDate: '2025-02-20' },
      ],
    }],
    cashInterestRate: 0.04, ordinaryIncome: 350000, filingStatus: 'single',
    stateCode: 'CA',
  },
  rsu_lot_optimize: {
    lots: [
      { vestDate: '2022-08-15', shares: 1200, costBasisPerShare: 95 },
      { vestDate: '2024-02-15', shares: 1000, costBasisPerShare: 130 },
      { vestDate: '2026-05-15', shares: 800, costBasisPerShare: 210 },
    ],
    currentPrice: 180, divestFraction: 0.5, horizonYears: 2,
    ordinaryIncome: 200000, filingStatus: 'single', stateCode: 'CA',
  },
};

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function rpc(body: unknown, sessionId?: string | null): Promise<{ json: any; sessionId: string | null }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: sessionId ? { ...HEADERS, 'mcp-session-id': sessionId } : HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text.startsWith('event:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    : JSON.parse(text);
  return { json, sessionId: res.headers.get('mcp-session-id') || sessionId || null };
}

async function main() {
  const init = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'optionsahoy-readme-capture', version: '1' },
    },
  });
  const session = init.sessionId;
  console.log(`initialized, session ${session || '(none)'}`);

  let id = 1;
  for (const [tool, args] of Object.entries(EXAMPLE_ARGS)) {
    const { json } = await rpc(
      { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } },
      session,
    );
    if (json.error || json.result?.isError) {
      console.error(`${tool}: FAILED`, JSON.stringify(json).slice(0, 800));
      process.exitCode = 1;
      continue;
    }
    const file = path.join(OUT_DIR, `${tool}.json`);
    writeFileSync(file, JSON.stringify({
      tool,
      endpoint: ENDPOINT,
      capturedAt: new Date().toISOString().slice(0, 10),
      request: { method: 'tools/call', params: { name: tool, arguments: args } },
      response: json.result,
    }, null, 2) + '\n');
    console.log(`${tool}: captured`);
  }

  // The prompts/get example under the MCP prompts table.
  const promptArgs = {
    shares: '50000', strike: '4', fmv: '90', expectedGrowth: '0.1',
    volatility: '0.5', state: 'CA', ordinaryIncome: '300000',
  };
  const { json: prompt } = await rpc(
    { jsonrpc: '2.0', id: ++id, method: 'prompts/get', params: { name: 'optimize-iso-exercise', arguments: promptArgs } },
    session,
  );
  if (prompt.error) {
    console.error('prompts/get: FAILED', JSON.stringify(prompt).slice(0, 800));
    process.exitCode = 1;
    return;
  }
  writeFileSync(path.join(OUT_DIR, 'prompts_get_optimize-iso-exercise.json'), JSON.stringify({
    tool: 'prompts/get optimize-iso-exercise',
    endpoint: ENDPOINT,
    capturedAt: new Date().toISOString().slice(0, 10),
    request: { method: 'prompts/get', params: { name: 'optimize-iso-exercise', arguments: promptArgs } },
    response: prompt.result,
  }, null, 2) + '\n');
  console.log('prompts/get: captured');
}

// Only when run as a script. The README drift guard imports EXAMPLE_ARGS from
// this file, and a test must never reach the network or rewrite the captures.
if (process.argv[1]?.endsWith('capture-readme-examples.mts')) main();
