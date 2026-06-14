// AlphaLatitude Inc. © 2026
//
// Post-deployment smoke test for the live /api/v1/* calculators. Exercises the
// DEPLOYED artifact (which unit tests can't), asserting invariants that must
// always hold in production:
//   - a valid request returns 200 with the expected top-level result keys
//   - malformed / extreme input never 500s and never leaks a stack trace
//   - results never contain NaN or Infinity
//   - schema-invalid input (negative shares, out-of-range, ...) returns 400
//     (a deployed-artifact regression guard for the input-validation contract)
//
// Usage:  node scripts/smoke-api.mjs [baseUrl]
//   baseUrl defaults to https://optionsahoy.com (the proxy -> pages path agents use).
// Exits 0 if every check passes, 1 (with a summary) on any failure.

const BASE = (process.argv[2] || 'https://optionsahoy.com').replace(/\/$/, '');
const UA = 'OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)';

// Leak signatures. Deliberately NOT a bare "stack" -- that matches the legitimate
// field name "stacks" in clean error bodies.
const LEAK = ['    at ', 'TypeError', 'ReferenceError', 'node_modules',
  'Cannot read', 'is not a function', 'undefined is not', '/src/', '.ts:', '.js:'];

// One valid payload per endpoint + the top-level result key it must return.
// Forward-looking fields are passed explicitly so the smoke does not depend on
// the ticker table.
const ENDPOINTS = {
  'amt-iso': {
    key: 'schedules',
    good: { shares: 8000, strike: 3, fmv: 40, filingStatus: 'single', ordinaryIncome: 250000, stateCode: 'CA', carryforwardCredit: 0, horizon: 5, cashReturnRate: 0.04, grantDate: '2022-03-01', hasLeftCompany: false, terminationDate: null, expectedGrowth: 0.12, volatility: 0.5 },
    invalid: [['shares', -100], ['horizon', 99]],
  },
  'nso': {
    key: 'exercise',
    good: { shares: 1000, strike: 2, currentPrice: 20, ordinaryIncome: 200000, filingStatus: 'single', stateCode: 'CA', stillEmployed: true, holdYears: 2, holdFunding: 'cash', expectedSalePrice: 30, volatility: 0.4, expectedMarketReturn: 0.07 },
    invalid: [['shares', -1], ['currentPrice', -5]],
  },
  'rsu-sell-vs-hold': {
    key: 'vest',
    good: { shares: 2000, currentPrice: 50, ordinaryIncome: 220000, filingStatus: 'single', stateCode: 'CA', stillEmployed: true, holdYears: 2, expectedSalePrice: 60, volatility: 0.4, expectedMarketReturn: 0.07 },
    invalid: [['holdYears', 9]],
  },
  'concentration': {
    key: 'riskBand',
    good: { positionValue: 400000, costBasis: 100000, acquisitionDate: '2022-01-01', sector: 'tech_software', stateCode: 'CA', filingStatus: 'single', ordinaryIncome: 200000, totalAssets: 1200000, expectedPositionReturn: 0.1, expectedMarketReturn: 0.07, volatility: 0.45 },
    invalid: [['positionValue', -1]],
  },
  'protective-put': {
    key: 'barePut',
    good: { positionValue: 400000, sector: 'tech_software', protectionLevel: 0.1, tenorYears: 1, volatility: 0.4 },
    invalid: [['protectionLevel', 5], ['tenorYears', 0.1]],
  },
  'qsbs': {
    key: 'verdict',
    good: { acquisitionDate: '2018-01-01', saleDate: '2026-02-01', entityType: 'us-c-corp', acquisitionMethod: 'original-issuance', assetCategory: 'under-50m', industry: 'tech-software', activeBusiness: 'yes', adjustedBasis: 10000, expectedGain: 2000000, stateCode: 'CA', ordinaryIncome: 250000, filingStatus: 'single' },
    invalid: [['adjustedBasis', -1]],
  },
  'equity-funding': {
    key: 'recommended',
    good: { targetAfterTax: 300000, targetDate: '2027-06-01', ordinaryIncome: 250000, filingStatus: 'single', stateCode: 'CA', stacks: [{ currentPrice: 50, expectedAnnualGrowth: 0.1, lots: [{ shares: 10000, costBasisPerShare: 8, acquisitionDate: '2022-01-01' }] }] },
    invalid: [['targetAfterTax', -1]],
  },
};

const JUNK = [null, '', 'xxx', [], {}, true, 1e308, 'NOT_AN_ENUM'];
const failures = [];
let checks = 0;

async function post(endpoint, body, raw) {
  const res = await fetch(`${BASE}/api/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function fail(endpoint, what, detail) {
  failures.push(`${endpoint}: ${what} -- ${detail}`);
}

function checkRobust(endpoint, label, status, text) {
  checks++;
  if (status >= 500) return fail(endpoint, label, `HTTP ${status} (server error)`);
  if (LEAK.some((m) => text.includes(m))) return fail(endpoint, label, `possible stack-trace/info leak in body`);
  if (text.includes('NaN') || text.includes('Infinity')) return fail(endpoint, label, `NaN/Infinity in response`);
  try { JSON.parse(text); } catch { return fail(endpoint, label, `non-JSON body`); }
}

async function run() {
  console.log(`Smoke-testing ${BASE}/api/v1/* ...`);
  for (const [endpoint, spec] of Object.entries(ENDPOINTS)) {
    // 1) valid request -> 200 with the expected result key
    checks++;
    try {
      const { status, text } = await post(endpoint, spec.good);
      const body = JSON.parse(text);
      if (status !== 200 || !body.ok || !body.result || !(spec.key in body.result)) {
        fail(endpoint, 'valid request', `expected 200 ok with result.${spec.key}; got ${status} ${text.slice(0, 120)}`);
      }
    } catch (e) { fail(endpoint, 'valid request', String(e)); }

    // 2) structural mutations -> never 5xx / leak / NaN
    for (const [field] of Object.entries(spec.good).slice(0, 3).map(([k]) => [k])) {
      for (const v of JUNK.slice(0, 3)) {
        const { status, text } = await post(endpoint, { ...spec.good, [field]: v });
        checkRobust(endpoint, `mutate ${field}`, status, text);
      }
    }

    // 3) malformed JSON body -> 4xx, not 5xx
    {
      checks++;
      const { status } = await post(endpoint, null, '{not valid json');
      if (status >= 500) fail(endpoint, 'malformed JSON', `HTTP ${status}`);
    }

    // 4) schema-invalid input -> 400 (deployed validation-contract regression guard)
    for (const [field, val] of spec.invalid) {
      checks++;
      const { status } = await post(endpoint, { ...spec.good, [field]: val });
      if (status !== 400) fail(endpoint, `invalid ${field}=${val}`, `expected 400, got ${status}`);
    }
  }

  console.log(`\nRan ${checks} checks across ${Object.keys(ENDPOINTS).length} endpoints.`);
  if (failures.length) {
    console.error(`\nSMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('SMOKE PASSED: all endpoints healthy, robust to bad input, validation contract enforced.');
}

run().catch((e) => { console.error('smoke harness error:', e); process.exit(1); });
