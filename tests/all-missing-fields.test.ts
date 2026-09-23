// AlphaLatitude Inc. © 2026
//
// One round trip per call, not one per missing field.
//
// The parsers are fail-fast, so an agent filling an unfamiliar schema learned
// about exactly one absent field per attempt. Building a valid
// concentration_analyze call by hand on 2026-09-22 took five attempts
// (acquisitionDate -> sector -> stateCode -> ordinaryIncome -> totalAssets),
// and production agrees: tools/call ran a 33% error rate over the 14 days to
// that date, and the top error fields were all omissions (volatility 96,
// expectedGrowth 49, expectedPositionReturn 29, targetDate 28).
//
// allMissingFields re-runs the parser in collecting mode after a failure. These
// tests pin the two properties that make that safe: it names every ABSENT
// field, and it never blames a field the caller supplied correctly.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/mcp';
import { TOOLS } from '../functions/_lib/mcp-tools';
import { allMissingFields } from '../functions/_lib/api';

const tool = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

function firstFailure(name: string, args: unknown): string {
  try {
    tool(name).handler(args);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${name} unexpectedly accepted ${JSON.stringify(args)}`);
}

const fieldsIn = (messages: string[]) =>
  messages.map((m) => m.match(/^field "([^"]+)"/)?.[1]).filter(Boolean) as string[];

describe('allMissingFields', () => {
  it('names every absent field of a near-empty call in one pass', () => {
    const args = { ticker: 'DDOG', positionValue: 400_000 };
    const messages = allMissingFields(
      tool('concentration_analyze').parse,
      args,
      firstFailure('concentration_analyze', args),
    );
    // The exact five that cost five round trips, plus the two the first
    // attempt would have reported on its own.
    expect(fieldsIn(messages)).toEqual(
      expect.arrayContaining([
        'costBasis',
        'acquisitionDate',
        'sector',
        'stateCode',
        'filingStatus',
        'ordinaryIncome',
        'totalAssets',
      ]),
    );
    expect(messages.length).toBeGreaterThanOrEqual(6);
  });

  it('reports only the omitted field when everything else is valid', () => {
    // Everything valid except one omission: the report must be that one field
    // and nothing else, so the collecting pass adds no spurious names.
    //
    // This does NOT pin the nullish filter in allMissingFields — removing that
    // filter leaves this green, because no parser currently has a cross-field
    // rule a placeholder can trip. Said plainly so nobody reads more assurance
    // into it than it gives.
    const args = {
      positionValue: 400_000,
      costBasis: 150_000,
      acquisitionDate: '2022-06-30',
      sector: 'tech_software',
      stateCode: 'CA',
      filingStatus: 'single',
      ordinaryIncome: 300_000,
      // totalAssets omitted
    };
    const messages = allMissingFields(
      tool('concentration_analyze').parse,
      args,
      firstFailure('concentration_analyze', args),
    );
    expect(fieldsIn(messages)).toEqual(['totalAssets']);
  });

  it('leaves a valid call alone (no collecting pass, no behaviour change)', () => {
    const args = {
      positionValue: 400_000,
      costBasis: 150_000,
      acquisitionDate: '2022-06-30',
      sector: 'tech_software',
      stateCode: 'CA',
      filingStatus: 'single',
      ordinaryIncome: 300_000,
      totalAssets: 900_000,
      volatility: 0.45,
      expectedPositionReturn: 0.08,
    };
    expect(() => tool('concentration_analyze').handler(args)).not.toThrow();
  });
});

describe('tools/call surfaces the whole list', () => {
  it('returns every missing field in one isError response', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'concentration_analyze', arguments: { positionValue: 400_000 } },
        }),
      }),
    });
    const json = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(json.result.isError).toBe(true);
    const text = json.result.content[0].text;
    for (const field of ['sector', 'stateCode', 'filingStatus', 'ordinaryIncome', 'totalAssets']) {
      expect(text, `did not name ${field}`).toContain(`field "${field}"`);
    }
  });
});
