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
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOOLS } from '../../functions/_lib/mcp-tools';

// Base is the MCP-repo spec (source of truth); the web copy is a byte mirror.
export const BASE = 'public/openapi.json';
const TARGETS = [BASE, '../optionsahoy_web/web/public/openapi.json'];

// tool name -> REST slug + PascalCase component prefix (matches the existing
// <Prefix>Input request schemas, so the response schema reads <Prefix>Result).
const TOOL_MAP = [
  { name: 'amt_iso_optimize', slug: 'amt-iso', prefix: 'AmtIso' },
  { name: 'nso_calculate', slug: 'nso', prefix: 'Nso' },
  { name: 'rsu_sell_vs_hold', slug: 'rsu-sell-vs-hold', prefix: 'Rsu' },
  { name: 'concentration_analyze', slug: 'concentration', prefix: 'Concentration' },
  { name: 'protective_put_price', slug: 'protective-put', prefix: 'ProtectivePut' },
  { name: 'qsbs_check', slug: 'qsbs', prefix: 'Qsbs' },
  { name: 'equity_funding_plan', slug: 'equity-funding', prefix: 'EquityFunding' },
] as const;

type Json = Record<string, any>;

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

  for (const { name, slug, prefix } of TOOL_MAP) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`gen-openapi: tool "${name}" not found in TOOLS`);
    const path = spec.paths?.[`/api/v1/${slug}`]?.post;
    if (!path) throw new Error(`gen-openapi: POST /api/v1/${slug} missing in openapi.json`);

    // The result schema mirrors the tool's MCP outputSchema exactly. Clone so
    // the returned spec never aliases the live TOOLS descriptors (a caller that
    // mutates the spec must not corrupt the source of truth).
    spec.components.schemas[`${prefix}Result`] = structuredClone(tool.outputSchema);

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
            },
          },
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

  let stale = 0;
  for (const path of TARGETS) {
    if (!existsSync(path)) {
      console.log(`skip (absent): ${path}`);
      continue;
    }
    if (check) {
      const current = readFileSync(path, 'utf8');
      const same = JSON.stringify(JSON.parse(current)) === JSON.stringify(spec);
      if (!same || current !== json) {
        console.error(`STALE: ${path} (run npm run gen:openapi)`);
        stale++;
      } else {
        console.log(`ok: ${path}`);
      }
    } else {
      writeFileSync(path, json);
      console.log(`wrote: ${path}`);
    }
  }
  if (check && stale > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
