// AlphaLatitude Inc. © 2026
//
// Cross-surface guard: the MCP tool inputSchema (public/toolspec.json, generated
// from functions/_lib/mcp-tools.ts) and the REST request schema
// (public/openapi.json <Prefix>Input) must declare the SAME set of input fields.
// verify:toolspec checks toolspec<->mcp-tools, and verify:openapi checks
// openapi<->its own generator, but nothing cross-checked the two agent-facing
// surfaces against each other -- which let volatilityDrag/haircut sit on REST
// while being absent from MCP for months (the parser honored them on both).
// This test closes that gap so the two surfaces cannot silently drift apart.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const toolspec = JSON.parse(readFileSync('public/toolspec.json', 'utf8')) as {
  tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
};
const openapi = JSON.parse(readFileSync('public/openapi.json', 'utf8')) as {
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

// MCP tool name -> the openapi component prefix (matches scripts/codegen/gen-openapi.mts TOOL_MAP).
const PREFIX: Record<string, string> = {
  amt_iso_optimize: 'AmtIso',
  nso_calculate: 'Nso',
  rsu_sell_vs_hold: 'Rsu',
  concentration_analyze: 'Concentration',
  protective_put_price: 'ProtectivePut',
  qsbs_check: 'Qsbs',
  equity_funding_plan: 'EquityFunding',
  rsu_lot_optimize: 'RsuLotOptimize',
};

describe('MCP toolspec <-> REST openapi input-field parity', () => {
  for (const tool of toolspec.tools) {
    it(`${tool.name} declares the same input fields on the MCP and REST surfaces`, () => {
      const prefix = PREFIX[tool.name];
      expect(prefix, `no openapi prefix mapped for tool ${tool.name}`).toBeTruthy();
      const input = openapi.components.schemas[`${prefix}Input`];
      expect(input, `openapi ${prefix}Input schema missing`).toBeTruthy();

      const mcpFields = Object.keys(tool.inputSchema.properties ?? {}).sort();
      const restFields = Object.keys(input.properties ?? {}).sort();
      expect(mcpFields).toEqual(restFields);
    });
  }

  it('covers every tool in the toolspec (no tool silently skipped)', () => {
    for (const tool of toolspec.tools) {
      expect(PREFIX[tool.name], `tool ${tool.name} not mapped in PREFIX`).toBeTruthy();
    }
  });
});
