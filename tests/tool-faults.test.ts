// AlphaLatitude Inc. © 2026
//
// toolFaults: tool-call/REST errors that were not the caller's input, i.e.
// our own exceptions. The ops MCP-health job alerts on any. Messages here are
// verbatim shapes from production logs (2026-10-02 audit: all 395 tools/call
// errors in 14 days were input errors or unknown tool names).

import { describe, expect, it } from 'vitest';
import { isCallerInputError, toolFaultsFrom } from '../functions/admin/mcp-stats';

describe('isCallerInputError', () => {
  it.each([
    'field "volatility" required: annualized sigma of the stock as a decimal',
    'field "targetDate" must be today or later: the deadline is in the past.',
    'parse: field "strike" must be a finite number',
    'unknown tool',
    'unknown tool: foo_bar',
    'invalid json',
    'method GET',
    // The pre-2026-10-09 stacks/lots wording: three of these turned the daily
    // MCP health check red as "tool faults" (a caller sent neither).
    'either "stacks" (v1.7+) or legacy "lots" + "currentPrice" required',
    'provide either "stacks" (v1.7+) or legacy "lots" + "currentPrice", not both.',
    'field "stacks" required: pass "stacks" (v1.7+), or legacy "lots" plus "currentPrice"',
  ])('caller error: %s', (m) => expect(isCallerInputError(m)).toBe(true));

  it.each([
    "Cannot read properties of undefined (reading 'calls')",
    'TypeError: x is not a function',
    'chain fetch failed',
    'fields "x" required', // not the parser's exact prefix
  ])('our fault: %s', (m) => expect(isCallerInputError(m)).toBe(false));
});

it('toolFaultsFrom keeps only our faults', () => {
  const rows = [
    { endpoint: 'mcp:tools/call', tool: 'nso_calculate', error_msg: 'field "shares" required', n: 40 },
    { endpoint: 'mcp:tools/call', tool: 'protective_put_price', error_msg: "Cannot read properties of null (reading 'spot')", n: 2 },
    { endpoint: 'rest:nso', tool: null, error_msg: 'invalid json', n: 5 },
  ];
  expect(toolFaultsFrom(rows)).toEqual([rows[1]]);
});
