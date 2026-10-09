// AlphaLatitude Inc. © 2026
//
// The public usage number counts successful tool calls from real callers
// (functions/_lib/toolCalls.ts). On 2026-10-08 the old counter published
// 14,682 "calls" in a day, 11,341 of them keep-alive pings from one client.

import { describe, it, expect } from 'vitest';
import { isToolCallEndpoint, toolCallStatsFrom } from '../functions/_lib/toolCalls';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const row = (day: string, endpoint: string, client: string, n: number, errors = 0) => ({ day, endpoint, client, n, errors });

describe('isToolCallEndpoint', () => {
  it.each(['mcp:tools/call', 'rest:nso', 'rest:amt-iso'])('%s ran a calculator', (e) => expect(isToolCallEndpoint(e)).toBe(true));
  it.each(['mcp:ping', 'mcp:initialize', 'mcp:tools/list', 'a2a', 'a2a:tasks/get', 'mcp:server/discover'])(
    '%s did not',
    (e) => expect(isToolCallEndpoint(e)).toBe(false),
  );
});

describe('toolCallStatsFrom', () => {
  it('counts only successes, from real callers, on tool endpoints, in each window', () => {
    const s = toolCallStatsFrom(
      [
        row('2026-10-09', 'mcp:tools/call', 'claude-ai', 10, 3), // 7 real successes, today
        row('2026-10-03', 'rest:nso', 'python-httpx/0.28.1', 5), // 5, inside 7 days (10-03..10-09)
        row('2026-10-02', 'mcp:tools/call', 'claude-ai', 4), // outside 7 days, inside 30
        row('2026-10-09', 'mcp:ping', 'copilot-cli', 11341), // not a tool call
        row('2026-10-09', 'mcp:tools/call', 'optionsahoy-conformance/1', 80), // our monitor
        row('2026-10-09', 'rest:qsbs', 'OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)', 40), // our smoke suite
        row('2026-10-09', 'mcp:tools/call', 'SaSame-MCP-Audit/0.1', 30, 30), // scanner
      ],
      NOW,
    );
    expect(s).toEqual({ last7d: 12, last30d: 16 });
  });

  it('is zero, not an error, with no rows', () => {
    expect(toolCallStatsFrom([], NOW)).toEqual({ last7d: 0, last30d: 0 });
  });
});
