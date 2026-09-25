// AlphaLatitude Inc. © 2026
//
// realTrafficByEndpoint: the dashboard's error rate for real callers. Shapes
// taken from the week to 2026-09-24, when the raw REST error rate (~92%) was
// almost entirely our own smoke suite's deliberate invalid payloads.

import { describe, expect, it } from 'vitest';
import { realTrafficByEndpoint } from '../functions/admin/mcp-stats';

describe('realTrafficByEndpoint', () => {
  const rows = [
    { endpoint: 'rest:nso', client: 'OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)', n: 230, errors: 212 },
    { endpoint: 'rest:nso', client: 'Mozilla/5.0 (X11; Linux x86_64)', n: 4, errors: 1 },
    { endpoint: 'mcp:tools/call', client: 'python-httpx/0.28.1', n: 640, errors: 143 },
    { endpoint: 'mcp:tools/call', client: 'optionsahoy-conformance/1', n: 100, errors: 0 },
    { endpoint: 'mcp:tools/call', client: 'SaSame-MCP-Audit/0.1', n: 30, errors: 30 },
    { endpoint: 'a2a', client: 'BrickBlueBot/0.1 (+https://brick.blue/bot; agentic-web registry)', n: 119, errors: 119 },
    { endpoint: 'a2a', client: 'okhttp/4.12.0', n: 4045, errors: 0 },
  ];

  it('drops monitors and scanners, keeps everyone else, and says how much it dropped', () => {
    const byEp = Object.fromEntries(realTrafficByEndpoint(rows).map((r) => [r.endpoint, r]));
    expect(byEp['rest:nso']).toEqual({ endpoint: 'rest:nso', n: 4, errors: 1, excluded: 230 });
    expect(byEp['mcp:tools/call']).toEqual({ endpoint: 'mcp:tools/call', n: 640, errors: 143, excluded: 130 });
    expect(byEp['a2a']).toEqual({ endpoint: 'a2a', n: 4045, errors: 0, excluded: 119 });
  });

  it('sorts by real call volume', () => {
    expect(realTrafficByEndpoint(rows).map((r) => r.endpoint)).toEqual(['a2a', 'mcp:tools/call', 'rest:nso']);
  });
});
