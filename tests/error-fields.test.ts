// AlphaLatitude Inc. © 2026
//
// Unit coverage for the input-friction field extractor. Guards the two ways it
// can go wrong: missing a real omitted field (recall) and admitting a garbage
// field name a fuzzer injected (the allowlist).

import { describe, it, expect } from 'vitest';
import { extractRequiredField, rankErrorFields, TOOL_INPUT_FIELDS } from '../functions/_lib/error-fields';

describe('extractRequiredField', () => {
  it('pulls the leading field name from both required and must-be messages', () => {
    expect(extractRequiredField('field "shares" required: pass a number')).toBe('shares');
    expect(extractRequiredField('field "volatility" must be <= 5')).toBe('volatility');
    expect(extractRequiredField('field "terminationDate" required when hasLeftCompany=true')).toBe('terminationDate');
  });

  it('collapses indexed/nested paths to the leaf field', () => {
    expect(extractRequiredField('field "stacks[0].expectedAnnualGrowth" required: ticker ...')).toBe('expectedAnnualGrowth');
    expect(extractRequiredField('field "lots[2].shares" must be >= 1')).toBe('shares');
  });

  it('catches the structural holdings errors that do not lead with field "..."', () => {
    // The single most common equity-funding friction: no holdings supplied.
    expect(extractRequiredField('either "stacks" (v1.7+) or legacy "lots" + "currentPrice" required')).toBe('stacks');
    expect(extractRequiredField('lots[2] must be an object with shares, costBasisPerShare, acquisitionDate')).toBe('lots');
    expect(extractRequiredField('field "shares" required: pass a number, or ticker "NVDA"')).toBe('shares'); // field before ticker
  });

  it('strips the REST parse:/calc: prefix so REST attributes like MCP', () => {
    // functions/_lib/api.ts wraps REST errors; the leading-bareword branch must
    // see the real message, not the prefix.
    expect(extractRequiredField('parse: lots[0] must be an object with shares')).toBe('lots');
    expect(extractRequiredField('parse: field "shares" required')).toBe('shares');
    expect(extractRequiredField('calc: stacks[1].lots must be a non-empty array')).toBe('stacks');
  });

  it('rejects messages with no quoted schema field', () => {
    expect(extractRequiredField('body must be a JSON object')).toBeNull();
    expect(extractRequiredField('field "notARealField" required')).toBeNull(); // allowlist
    expect(extractRequiredField('')).toBeNull();
    expect(extractRequiredField(null)).toBeNull();
  });

  it('the allowlist is populated from the real tool schemas', () => {
    expect(TOOL_INPUT_FIELDS.has('shares')).toBe(true);
    expect(TOOL_INPUT_FIELDS.has('expectedAnnualGrowth')).toBe(true); // nested under stacks[].lots
    expect(TOOL_INPUT_FIELDS.size).toBeGreaterThan(30);
  });
});

describe('rankErrorFields', () => {
  it('tallies by field, sorts by count desc then name, and drops non-fields', () => {
    const ranked = rankErrorFields([
      { errorMsg: 'field "shares" required', n: 4 },
      { errorMsg: 'field "shares" must be a whole number', n: 1 },
      { errorMsg: 'field "volatility" must be <= 5', n: 3 },
      { errorMsg: 'field "notARealField" required', n: 99 },
      { errorMsg: 'body must be a JSON object', n: 50 },
    ]);
    expect(ranked).toEqual([
      { field: 'shares', count: 5 },
      { field: 'volatility', count: 3 },
    ]);
  });

  it('honors the limit', () => {
    const rows = [...TOOL_INPUT_FIELDS].slice(0, 20).map((f, i) => ({ errorMsg: `field "${f}" required`, n: 20 - i }));
    expect(rankErrorFields(rows, 5)).toHaveLength(5);
  });
});
