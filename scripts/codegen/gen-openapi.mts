// AlphaLatitude Inc. © 2026
//
// Generates the per-tool response schemas in public/openapi.json (and the
// optionsahoy_web mirror) from the TOOLS source of truth, so the OpenAPI spec's
// `result` shapes cannot drift from the MCP tool `outputSchema`s. Before this,
// every /api/v1/* endpoint shared one generic response whose `result` was a bare
// `{ type: object }` ("shape varies by endpoint") - agents and generated clients
// had no machine-readable output contract. This codegen wires each endpoint's
// 200 response to a component schema mirroring that tool's outputSchema.
//
// The hand-maintained parts of openapi.json (servers, request bodies, error
// responses, tags, examples) are read and preserved; only the per-tool
// `components/schemas/<Tool>Result`, `components/responses/<Tool>Success`, and
// each tool endpoint's `responses.200` are (re)generated. The drift guard that
// runs in the test suite is tests/openapi-responses-generated.test.ts.
//
//   npm run gen:openapi      # write the files
//   npm run verify:openapi   # --check: exit 1 if any on-disk copy is stale
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOOLS, type ToolName } from '../../functions/_lib/mcp-tools';
import {
  parseAmtIsoInput,
  parseNsoInput,
  parseRsuInput,
  parseConcentrationInput,
  parseProtectivePutInput,
  parseQsbsInput,
  parseEquityFundingInput,
  parseRsuLotOptimizeInput,
} from '../../functions/_lib/calc-parsers';
import { computeAmtIso } from '../../lib/calc/amtIso';
import { computeNsoResult } from '../../lib/calc/nso';
import { computeRsuResult } from '../../lib/calc/rsu';
import { calculate as computeConcentration } from '../../lib/calc/concentration';
import { calculateProtectivePut } from '../../lib/calc/protectivePut';
import { evaluateQsbs } from '../../lib/calc/qsbs';
import { computeEquityFundingComparison } from '../../lib/calc/equityFunding';
import { computeLotDivestPlan } from '../../lib/calc/lotDivest';

// Base is the MCP-repo spec (source of truth); the web copy is a byte mirror.
export const BASE = 'public/openapi.json';
const TARGETS = [BASE, '../optionsahoy_web/web/public/openapi.json'];

type Json = Record<string, any>;

// The response examples are the ACTUAL calc output for the request example, so
// they can never claim a shape the engine doesn't produce. Several calcs default
// to an ambient "today" (amt exercise-window countdown, equity-funding
// months-to-goal, plus nso / concentration internals), which would make the
// committed example drift every day. Rather than thread an explicit clock
// through each seam - which would miss any calc that reads the clock without one
// - freeze the whole computation to one instant so buildOpenApi() is time-
// deterministic no matter which calc reads it. The drift guard
// (tests/openapi-responses-generated.test.ts) regenerates through the same
// frozen path. Only the zero-arg `new Date()` is pinned - `new Date("2022-01-15")`
// from the input parsers is untouched.
const EXAMPLE_CLOCK = '2026-06-24T12:00:00Z';

function withFrozenClock<T>(fn: () => T): T {
  const RealDate = Date;
  class Frozen extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(EXAMPLE_CLOCK);
      else super(...(args as [any]));
    }
    static now(): number {
      return new RealDate(EXAMPLE_CLOCK).getTime();
    }
  }
  (globalThis as any).Date = Frozen;
  try {
    return fn();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}

// tool name -> REST slug + PascalCase component prefix (matches the existing
// <Prefix>Input request schemas, so the response schema reads <Prefix>Result),
// plus a canonical request example and how to run it. The examples are
// ticker-less on purpose: passing explicit volatility / expected-return beliefs
// makes the parsers skip BOTH ticker lookups - the trailing-return table and the
// published volatility feed - so neither a daily ETL refresh nor the feed's
// last-close freshness gate (nor the feed being down) can change the committed
// example, or make generating it depend on the network. `run` mirrors the REST handler pipeline: parse the public JSON, then
// compute (see functions/api/v1/<slug>.ts).
type ToolEntry = {
  name: ToolName;
  slug: string;
  prefix: string;
  request: Json;
  run: (raw: Json) => unknown;
};

export const TOOL_MAP: readonly ToolEntry[] = [
  {
    name: 'amt_iso_optimize',
    slug: 'amt-iso',
    prefix: 'AmtIso',
    request: {
      shares: 10000,
      strike: 2,
      fmv: 200,
      expectedGrowth: 0.15,
      volatility: 0.5,
      filingStatus: 'married_joint',
      ordinaryIncome: 400000,
      stateCode: 'CA',
      carryforwardCredit: 0,
      horizon: 4,
      cashReturnRate: 0.05,
      grantDate: '2022-01-15',
      hasLeftCompany: false,
      terminationDate: null,
    },
    run: (raw) => computeAmtIso(parseAmtIsoInput(raw)),
  },
  {
    name: 'nso_calculate',
    slug: 'nso',
    prefix: 'Nso',
    request: {
      shares: 5000,
      strike: 10,
      currentPrice: 50,
      expectedSalePrice: 80,
      expectedMarketReturn: 0.07,
      ordinaryIncome: 180000,
      filingStatus: 'single',
      stateCode: 'CA',
      stillEmployed: true,
      holdYears: 2,
      volatility: 0.3,
      holdFunding: 'cash',
    },
    run: (raw) => computeNsoResult(parseNsoInput(raw)),
  },
  {
    name: 'rsu_sell_vs_hold',
    slug: 'rsu-sell-vs-hold',
    prefix: 'Rsu',
    request: {
      shares: 1000,
      currentPrice: 100,
      expectedSalePrice: 130,
      expectedMarketReturn: 0.07,
      ordinaryIncome: 200000,
      filingStatus: 'single',
      stateCode: 'CA',
      stillEmployed: true,
      holdYears: 2,
      volatility: 0.3,
    },
    run: (raw) => computeRsuResult(parseRsuInput(raw)),
  },
  {
    name: 'concentration_analyze',
    slug: 'concentration',
    prefix: 'Concentration',
    request: {
      positionValue: 400000,
      costBasis: 100000,
      acquisitionDate: '2022-01-01',
      sector: 'tech_software',
      stateCode: 'CA',
      filingStatus: 'single',
      ordinaryIncome: 200000,
      totalAssets: 1200000,
      volatility: 0.45,
      expectedPositionReturn: 0.1,
      expectedMarketReturn: 0.07,
    },
    run: (raw) => computeConcentration(parseConcentrationInput(raw)),
  },
  {
    name: 'protective_put_price',
    slug: 'protective-put',
    prefix: 'ProtectivePut',
    request: {
      positionValue: 400000,
      sector: 'tech_software',
      protectionLevel: 0.1,
      tenorYears: 1,
      spreadRiskLevel: 0.1,
      volatility: 0.4,
    },
    run: (raw) => calculateProtectivePut(parseProtectivePutInput(raw)),
  },
  {
    name: 'qsbs_check',
    slug: 'qsbs',
    prefix: 'Qsbs',
    request: {
      acquisitionDate: '2020-01-15',
      saleDate: '2026-06-01',
      entityType: 'us-c-corp',
      acquisitionMethod: 'original-issuance',
      assetCategory: 'under-50m',
      industry: 'tech-software',
      activeBusiness: 'yes',
      adjustedBasis: 100000,
      expectedGain: 5000000,
      stateCode: 'CA',
      ordinaryIncome: 250000,
      filingStatus: 'single',
    },
    run: (raw) => evaluateQsbs(parseQsbsInput(raw)),
  },
  {
    name: 'equity_funding_plan',
    slug: 'equity-funding',
    prefix: 'EquityFunding',
    request: {
      targetAfterTax: 200000,
      targetDate: '2028-01-01',
      ordinaryIncome: 200000,
      filingStatus: 'single',
      stateCode: 'CA',
      cashInterestRate: 0.04,
      stacks: [
        {
          currentPrice: 100,
          expectedAnnualGrowth: 0.08,
          volatility: 0.4,
          lots: [{ shares: 2000, costBasisPerShare: 20, acquisitionDate: '2022-01-01' }],
        },
      ],
    },
    run: (raw) => computeEquityFundingComparison(parseEquityFundingInput(raw)),
  },
  {
    name: 'rsu_lot_optimize',
    slug: 'rsu-lot-order',
    prefix: 'RsuLotOptimize',
    request: {
      lots: [
        { vestDate: '2022-08-15', shares: 120, costBasisPerShare: 95 },
        { vestDate: '2024-02-15', shares: 100, costBasisPerShare: 130 },
        { vestDate: '2026-05-15', shares: 80, costBasisPerShare: 210 },
      ],
      currentPrice: 180,
      divestFraction: 0.5,
      horizonYears: 2,
      ordinaryIncome: 200000,
      filingStatus: 'single',
      stateCode: 'CA',
    },
    run: (raw) => computeLotDivestPlan(parseRsuLotOptimizeInput(raw)),
  },
] as const;

export function buildOpenApi(): Json {
  const spec = JSON.parse(readFileSync(BASE, 'utf8')) as Json;
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  spec.components ??= {};
  spec.components.schemas ??= {};
  spec.components.responses ??= {};

  // Completeness: every tool must be mapped, else a new tool's endpoint would
  // silently keep the bare-result envelope this codegen exists to replace.
  const mapped = new Set(TOOL_MAP.map((m) => m.name));
  for (const t of TOOLS) {
    if (!mapped.has(t.name)) {
      throw new Error(`gen-openapi: tool "${t.name}" is not in TOOL_MAP - add its slug + prefix`);
    }
  }

  for (const entry of TOOL_MAP) {
    const { name, slug, prefix } = entry;
    const tool = byName.get(name);
    if (!tool) throw new Error(`gen-openapi: tool "${name}" not found in TOOLS`);
    const path = spec.paths?.[`/api/v1/${slug}`]?.post;
    if (!path) throw new Error(`gen-openapi: POST /api/v1/${slug} missing in openapi.json`);

    // The result schema mirrors the tool's MCP outputSchema exactly. Clone so
    // the returned spec never aliases the live TOOLS descriptors (a caller that
    // mutates the spec must not corrupt the source of truth).
    spec.components.schemas[`${prefix}Result`] = structuredClone(tool.outputSchema);

    // A canonical request example, and the ACTUAL calc output for it as the
    // response example - so a reader sees a real request paired with the real
    // answer it produces, and neither can drift from the engine. The request
    // is cloned into both the spec and the run input so the stored example is
    // never aliased or mutated by the parser.
    const request = structuredClone(entry.request);
    const result = withFrozenClock(() => entry.run(structuredClone(entry.request)));
    const reqMedia = path.requestBody?.content?.['application/json'];
    if (!reqMedia) {
      throw new Error(`gen-openapi: POST /api/v1/${slug} has no application/json request body`);
    }
    reqMedia.example = request;

    // A typed success envelope: { ok: true, result: <the tool's output> }.
    spec.components.responses[`${prefix}Success`] = {
      description: `Successful ${name} result.`,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['ok', 'result'],
            properties: {
              ok: { type: 'boolean', const: true },
              result: { $ref: `#/components/schemas/${prefix}Result` },
              // Optional, constant per endpoint: the free web calculator for
              // this tool, related endpoints to run next, and the beta. Not in
              // `required` so strict consumers of older responses stay valid.
              next_steps: {
                type: 'object',
                description:
                  'Constant per endpoint: the free interactive version of this calculator, related endpoints worth running next, and the OptionsAhoy beta for integrated multi-position optimization.',
                properties: {
                  web_tool: { type: 'string' },
                  also_run: { type: 'array', items: { type: 'string' } },
                  beta: { type: 'string' },
                },
              },
            },
          },
          example: { ok: true, result },
        },
      },
    };

    path.responses['200'] = { $ref: `#/components/responses/${prefix}Success` };
  }
  return spec;
}

// CLI: `gen-openapi.mts` writes the files; `--check` verifies them. Guarded so
// importing buildOpenApi() from the drift test has no side effects.
function main(): void {
  const spec = buildOpenApi();
  const json = JSON.stringify(spec, null, 2) + '\n';
  const check = process.argv.includes('--check');

  const isAbsent = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

  let stale = 0;
  for (const path of TARGETS) {
    // Read/write directly and treat a missing file as "skip" - checking
    // existsSync first is a time-of-check/time-of-use race (js/file-system-race).
    if (check) {
      let current: string;
      try {
        current = readFileSync(path, 'utf8');
      } catch (err) {
        if (isAbsent(err)) {
          console.log(`skip (absent): ${path}`);
          continue;
        }
        throw err;
      }
      const same = JSON.stringify(JSON.parse(current)) === JSON.stringify(spec);
      if (!same || current !== json) {
        console.error(`STALE: ${path} (run npm run gen:openapi)`);
        stale++;
      } else {
        console.log(`ok: ${path}`);
      }
    } else {
      try {
        writeFileSync(path, json);
      } catch (err) {
        if (isAbsent(err)) {
          console.log(`skip (absent): ${path}`);
          continue;
        }
        throw err;
      }
      console.log(`wrote: ${path}`);
    }
  }
  if (check && stale > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
