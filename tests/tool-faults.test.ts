// AlphaLatitude Inc. © 2026
//
// toolFaults: tool-call/REST errors that were not the caller's input, i.e.
// our own exceptions. The ops MCP-health job alerts on any. Messages here are
// verbatim shapes from production logs (2026-10-02 audit: all 395 tools/call
// errors in 14 days were input errors or unknown tool names).

import { describe, expect, it } from 'vitest';
import { isCallerInputError, toolFaultsFrom } from '../functions/admin/mcp-stats';
import { parseEquityFundingInput, parseRsuLotOptimizeInput } from '../functions/_lib/calc-parsers';
import { TOOLS } from '../functions/_lib/mcp-tools';

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
    // A field inside an element of an array input (a future vestDate): logged
    // rows of this turned the health check red from 2026-11-08. The parsers'
    // other element shapes are made by the parsers themselves, further down.
    'lots[0] field "vestDate" must be on or before today: this tool covers vested lots only, and unvested grants are out of scope.',
    // Deeper paths no parser emits yet, so a nested rejection added later reads
    // the same way.
    'stacks[1].lots[2] must be an object with shares, costBasisPerShare, acquisitionDate',
    'stacks[1].lots[2] field "vestDate" is not a valid date; use ISO format like "2028-06-30"',
    'field "stacks[0].expectedAnnualGrowth" required: pass a decimal annual rate',
    // A tools/call with no params object, or a non-string tool name.
    'Invalid params',
    'name not a string',
  ])('caller error: %s', (m) => expect(isCallerInputError(m)).toBe(true));

  it.each([
    "Cannot read properties of undefined (reading 'calls')",
    'TypeError: x is not a function',
    'chain fetch failed',
    'fields "x" required', // not the parser's exact prefix
    // A TypeError can lead with an element path too.
    'lots[0].map is not a function',
    'stacks[0].lots is not iterable',
    // A NaN, a timeout, an internal error.
    'expected a finite number, got NaN',
    'Invalid time value',
    'The operation was aborted due to timeout',
    'internal error',
    // "field" mid-sentence, not where a parser rejection puts it.
    'unexpected field "bid" in chain response',
    'lots[0] is missing field "shares"',
    // REST: a calculation failure is ours whatever it says, and so is a parser
    // that crashed rather than rejected.
    'calc: field "stacks" must be a non-empty array',
    "parse: Cannot read properties of undefined (reading 'lots')",
    'response body must be a JSON object',
  ])('our fault: %s', (m) => expect(isCallerInputError(m)).toBe(false));
});

// Made by the real parsers rather than copied, so a reworded throw that leaves
// the shapes above fails here instead of turning the health check red. MCP logs
// each one bare and REST as `parse: <message>`.
describe('every structural parser rejection is caller input', () => {
  const today = new Date('2026-11-14T12:00:00Z');
  const rsu = { currentPrice: 100, divestFraction: 0.5, horizonYears: 2, ordinaryIncome: 200_000, filingStatus: 'single', stateCode: 'CA' };
  const rsuLot = { vestDate: '2024-01-15', shares: 100, costBasisPerShare: 50 };
  const funding = { targetAfterTax: 100_000, targetDate: '2027-06-30', ordinaryIncome: 200_000, filingStatus: 'single', stateCode: 'CA' };
  const fundingLot = { shares: 100, costBasisPerShare: 50, acquisitionDate: '2024-01-15' };
  const stack = { currentPrice: 100, expectedAnnualGrowth: 0.05, lots: [fundingLot] };

  const rejection = (parse: () => unknown): string => {
    try {
      parse();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('the parser accepted the input');
  };
  const expectCallerInput = (msg: string) => {
    expect(isCallerInputError(msg)).toBe(true);
    expect(isCallerInputError(`parse: ${msg}`)).toBe(true);
  };

  it.each([
    ['rsu_lot_optimize, future vestDate', /^lots\[0\] field "vestDate" must be on or before today/,
      () => parseRsuLotOptimizeInput({ ...rsu, lots: [{ ...rsuLot, vestDate: '2099-01-15' }] }, today)],
    ['rsu_lot_optimize, zero-share lot', /^lots\[1\] field "shares" must be greater than 0$/,
      () => parseRsuLotOptimizeInput({ ...rsu, lots: [rsuLot, { ...rsuLot, shares: 0 }] }, today)],
    ['rsu_lot_optimize, lot not an object', /^lots\[0\] must be an object/,
      () => parseRsuLotOptimizeInput({ ...rsu, lots: [5] }, today)],
    ['equity_funding_plan, legacy lot not an object', /^lots\[0\] must be an object/,
      () => parseEquityFundingInput({ ...funding, currentPrice: 100, expectedAnnualGrowth: 0.05, lots: ['x'] }, today)],
    ['equity_funding_plan, stack not an object', /^stacks\[0\] must be an object/,
      () => parseEquityFundingInput({ ...funding, stacks: [7] }, today)],
    ['equity_funding_plan, stack with no lots', /^stacks\[1\]\.lots must be a non-empty array$/,
      () => parseEquityFundingInput({ ...funding, stacks: [stack, { ...stack, lots: [] }] }, today)],
    ['equity_funding_plan, stack lot not an object', /^lots\[1\] must be an object/,
      () => parseEquityFundingInput({ ...funding, stacks: [{ ...stack, lots: [fundingLot, null] }] }, today)],
  ])('%s', (_name, shape, parse) => {
    const msg = rejection(parse);
    expect(msg).toMatch(shape);
    expectCallerInput(msg);
  });

  it.each(TOOLS.map((t) => [t.name, t.parse] as const))('%s, arguments that are not an object', (_name, parse) => {
    for (const args of [[], 'shares=100']) {
      const msg = rejection(() => parse(args));
      expect(msg).toBe('body must be a JSON object');
      expectCallerInput(msg);
    }
  });
});

it('toolFaultsFrom keeps only our faults', () => {
  const rows = [
    { endpoint: 'mcp:tools/call', tool: 'nso_calculate', error_msg: 'field "shares" required', n: 40 },
    { endpoint: 'mcp:tools/call', tool: 'protective_put_price', error_msg: "Cannot read properties of null (reading 'spot')", n: 2 },
    { endpoint: 'rest:nso', tool: null, error_msg: 'invalid json', n: 5 },
  ];
  expect(toolFaultsFrom(rows)).toEqual([rows[1]]);
});
