// AlphaLatitude Inc. © 2026
//
// The traffic breakdown behind the admin funnel (functions/_lib/traffic.ts):
// every logged request, which is what the public call count counts, split by
// caller and by type.

import { describe, it, expect } from 'vitest';
import { describeEndpoint, isWorkEndpoint, trafficBreakdown } from '../functions/_lib/traffic';

const SMOKE = 'OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)';
const ROWS = [
  { endpoint: 'mcp:ping', client: 'copilot-cli', n: 900, errors: 0 },
  { endpoint: 'mcp:initialize', client: 'copilot-cli', n: 50, errors: 0 },
  { endpoint: 'mcp:server/discover', client: 'copilot-cli', n: 50, errors: 50 },
  { endpoint: 'mcp:tools/call', client: 'python-httpx/0.28.1', n: 40, errors: 10 },
  { endpoint: 'rest:nso', client: SMOKE, n: 200, errors: 190 },
  { endpoint: 'mcp:tools/list', client: 'SaSame-MCP-Audit/0.1', n: 30, errors: 0 },
  { endpoint: 'a2a', client: 'okhttp/4.12.0', n: 5, errors: 1 },
];

describe('trafficBreakdown', () => {
  const t = trafficBreakdown(ROWS);

  it('adds up to every logged request, which is what the public counters count', () => {
    expect(t.total).toBe(1275);
    expect(t.callers).toBe(5);
    expect(t.byEndpoint.reduce((a, e) => a + e.n, 0)).toBe(t.total);
    expect(t.byKind.reduce((a, k) => a + k.n, 0)).toBe(t.total);
  });

  it('counts calculations (tools/call, REST, A2A messages) apart from housekeeping', () => {
    expect(t.work).toBe(245); // 40 + 200 + 5
    expect(t.workOk).toBe(44); // 30 + 10 + 4
  });

  it('names each caller, classifies it, and says what it mostly sent', () => {
    expect(t.byCaller[0]).toEqual({
      client: 'copilot-cli',
      kind: 'human',
      label: 'human (AI assistant)',
      n: 1000,
      work: 0,
      workOk: 0,
      top: [
        { endpoint: 'mcp:ping', n: 900 },
        { endpoint: 'mcp:initialize', n: 50 },
        { endpoint: 'mcp:server/discover', n: 50 },
      ],
    });
    expect(t.byCaller.map((c) => c.kind)).toEqual(['human', 'smoke', 'tool', 'crawler', 'tool']);
  });

  it('groups callers by kind, largest first', () => {
    expect(t.byKind.map((k) => [k.kind, k.callers, k.n, k.work, k.workOk])).toEqual([
      ['human', 1, 1000, 0, 0],
      ['smoke', 1, 200, 200, 10],
      ['tool', 2, 45, 45, 34],
      ['crawler', 1, 30, 0, 0],
    ]);
    expect(t.byKind[1].label).toBe('Our own monitors and tests');
  });

  it('keeps the top callers and folds the rest into one line', () => {
    const top2 = trafficBreakdown(ROWS, 2);
    expect(top2.byCaller.map((c) => c.client)).toEqual(['copilot-cli', SMOKE]);
    expect(top2.otherCallers).toEqual({ callers: 3, n: 75, work: 45, workOk: 34 });
  });

  it('is empty, not broken, for a window with no rows', () => {
    expect(trafficBreakdown([])).toEqual({
      total: 0, callers: 0, work: 0, workOk: 0, byKind: [], byCaller: [],
      otherCallers: { callers: 0, n: 0, work: 0, workOk: 0 }, byEndpoint: [],
    });
  });
});

describe('describeEndpoint', () => {
  it('says what each request type is, including ones it has never seen', () => {
    expect(describeEndpoint('mcp:ping')).toBe('Keep-alive from a connected client. Does no work.');
    expect(describeEndpoint('rest:amt-iso')).toBe('A calculation through the REST API.');
    expect(describeEndpoint('a2a:bad-method')).toBe('An A2A method we do not serve.');
    expect(describeEndpoint('mcp:this/method/does/not/exist')).toBe('A method we do not serve, or a malformed request.');
  });

  it('labels the breakdown rows with it', () => {
    expect(trafficBreakdown(ROWS).byEndpoint[0]).toEqual({
      endpoint: 'mcp:ping', what: describeEndpoint('mcp:ping'), n: 900, errors: 0,
    });
  });
});

describe('isWorkEndpoint', () => {
  it('is true for calculations only', () => {
    expect(['mcp:tools/call', 'rest:nso', 'a2a'].every(isWorkEndpoint)).toBe(true);
    expect(['mcp:ping', 'mcp:tools/list', 'a2a:tasks/get', 'poe:query'].some(isWorkEndpoint)).toBe(false);
  });
});
