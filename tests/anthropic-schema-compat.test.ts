// AlphaLatitude Inc. © 2026
//
// The Anthropic Messages API rejects a tool whose input_schema has a
// TOP-LEVEL oneOf/allOf/anyOf:
//
//   tools.6.custom.input_schema: input_schema does not support oneOf, allOf,
//   or anyOf at the top level
//
// It validates the whole tools array, so ONE such schema 400s the ENTIRE
// request - all eight tools, not just the offender. Every client that bridges
// MCP descriptors into that API is affected: Claude Desktop, claude.ai
// connectors, plain SDK callers.
//
// equity_funding_plan shipped with `anyOf: [{required:['stacks']},
// {required:['lots','currentPrice']}]` for its legacy-caller path. Found
// 2026-08-12 by scripts/link-survival.mjs, which drives real models against
// the live server: every Anthropic run failed with a 400 while OpenAI and
// Gemini runs passed. Verified directly against the API - as shipped 400,
// with the anyOf removed 200.
//
// Conditional requirements belong in the parser, which returns a named-field
// error at call time. That is where every other one in this suite lives.

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../functions/_lib/mcp-tools';
import { readFileSync } from 'fs';

const FORBIDDEN = ['oneOf', 'allOf', 'anyOf'] as const;

describe('tool schemas stay loadable by the Anthropic Messages API', () => {
  it.each(TOOLS.map((t) => [t.name, t] as const))(
    '%s has no top-level oneOf/allOf/anyOf',
    (name, tool) => {
      const schema = tool.inputSchema as Record<string, unknown>;
      const found = FORBIDDEN.filter((k) => k in schema);
      expect(found, `${name}: Anthropic 400s the whole tools array over this`).toEqual([]);
    },
  );

  it('the published toolspec mirror is clean too', () => {
    // The mirror is what non-MCP integrations read, and it is generated - so
    // a regression here means the generator ran before the fix, not that
    // someone hand-edited it.
    const spec = JSON.parse(readFileSync('public/toolspec.json', 'utf8')) as unknown;
    const tools = Array.isArray(spec) ? spec : ((spec as { tools?: unknown[] }).tools ?? []);
    for (const t of tools as Array<{ name: string; inputSchema?: Record<string, unknown> }>) {
      const found = FORBIDDEN.filter((k) => k in (t.inputSchema ?? {}));
      expect(found, `${t.name} in toolspec.json`).toEqual([]);
    }
  });
});
