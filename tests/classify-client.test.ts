// AlphaLatitude Inc. © 2026
//
// classifyClient buckets a captured example into real-vs-bot. Cases are
// grounded in the ACTUAL client strings seen in the live mcp_samples table
// (admin/mcp-stats?format=json): OptionsAhoy-smoke, Claude-User, browser UAs,
// and (none). The heuristic is best-effort (UA is spoofable), so these tests
// pin the unambiguous buckets, not every conceivable string.

import { describe, it, expect } from 'vitest';
import { classifyClient, networkKind, KIND_RANK, type ClientKind } from '../functions/admin/mcp-stats';
import { isInfraClient, isRealClient } from '../functions/_lib/classify';

const kind = (c: string | null | undefined, surface = 'rest'): ClientKind =>
  classifyClient(c, surface).kind;

describe('classifyClient — real-vs-bot of captured examples', () => {
  it('our own smoke monitor is "smoke" (the dominant REST UA in prod)', () => {
    expect(kind('OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)')).toBe('smoke');
  });

  it('Poe surface is a human regardless of client_name', () => {
    expect(kind('poe', 'poe')).toBe('human');
    expect(kind(null, 'poe')).toBe('human');
  });

  it('Claude-User (a person driving Claude over MCP) is a human', () => {
    expect(kind('Claude-User', 'mcp')).toBe('human');
  });

  it('interactive AI clients (a person is in the loop) are human', () => {
    for (const c of ['claude.ai', 'Cursor', 'cline', 'Windsurf', 'Continue', 'Zed', 'ChatGPT-User', 'LibreChat']) {
      expect(kind(c, 'mcp')).toBe('human');
    }
  });

  it('automated agent frameworks / SDKs are agents, not humans', () => {
    for (const c of ['langchain', 'llama-index', 'crewai', 'fast-agent', 'anthropic-sdk', 'openai-python']) {
      expect(kind(c, 'mcp')).toBe('agent');
    }
  });

  it('Anthropic crawler claudebot is NOT confused with Claude-User', () => {
    expect(kind('ClaudeBot/1.0 (+https://anthropic.com)')).toBe('crawler');
    expect(kind('Claude-User')).toBe('human');
  });

  it('search/training crawlers and scanners are crawlers', () => {
    for (const c of ['Googlebot/2.1', 'GPTBot/1.0', 'bingbot', 'Nuclei - Open-source', 'masscan/1.3']) {
      expect(kind(c)).toBe('crawler');
    }
  });

  it('MCP directory probes / registry crawlers are crawlers (the dominant prod traffic)', () => {
    // Real handshake names seen in prod, in descending volume. These constantly
    // re-introspect any listed server and must not count as real engagement.
    for (const c of ['glimind-probe', 'mcpregistry', 'smithery-probe', 'aisec-registry-probe',
      'MCPScoringEngine', 'capability-probe', 'mcpcentral-scanner', 'glama-mcp-inspector',
      'see-registry-introspector', 'drio-upstream-discovery', 'chariot-verifier', 'sasame-audit']) {
      expect(kind(c, 'mcp')).toBe('crawler');
    }
  });

  it('a scanner named after its research topic is a crawler, not an agent (regression)', () => {
    // Prod case: 'mcp-rugpull-research' (periodic tools/list differ, present in
    // every stats snapshot) carried no scanner verb, so it fell through to the
    // \bmcp- agent catch-all and inflated the funnel's real-client connects.
    expect(kind('mcp-rugpull-research', 'mcp')).toBe('crawler');
    expect(isRealClient('mcp-rugpull-research', 'mcp')).toBe(false);
    // The mcp- catch-all still does its real job for genuine agent platforms.
    expect(kind('retell-mcp-client', 'mcp')).toBe('agent');
    expect(isRealClient('retell-mcp-client', 'mcp')).toBe(true);
  });

  it('real agent frameworks are NOT swept up by the probe patterns', () => {
    // 'index' is deliberately absent from the crawler regex so llama-index
    // stays an agent; python-httpx stays a tool.
    expect(kind('llama-index', 'mcp')).toBe('agent');
    expect(kind('python-httpx/0.28.1', 'mcp')).toBe('tool');
  });

  it('generic HTTP clients and empty UA are scripts/tools', () => {
    for (const c of ['curl/8.4.0', 'python-requests/2.31', 'Go-http-client/2.0', 'node-fetch', 'PostmanRuntime/7.36', '']) {
      expect(kind(c)).toBe('tool');
    }
  });

  it('a raw browser UA hitting the JSON API is a manual/script test, not a user', () => {
    // Real value from prod: a Chrome UA calling REST directly.
    expect(kind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')).toBe('tool');
  });

  it('truly unrecognized strings are unknown (ranked above noise, below real)', () => {
    expect(kind('some-new-mcp-host-we-have-not-seen')).toBe('agent'); // matches mcp- prefix
    expect(kind('zxqv-internal-9000')).toBe('unknown');
    expect(KIND_RANK.unknown).toBeGreaterThan(KIND_RANK.agent);
    expect(KIND_RANK.unknown).toBeLessThan(KIND_RANK.tool);
  });
});

describe('isInfraClient — what the sample capture drops', () => {
  it('smoke suite and crawlers/probes are infrastructure (skipped from capture)', () => {
    expect(isInfraClient('OptionsAhoy-smoke/1.0 (Mozilla/5.0 compatible)', 'rest')).toBe(true);
    expect(isInfraClient('glimind-probe', 'mcp')).toBe(true);
    expect(isInfraClient('Googlebot/2.1', 'rest')).toBe(true);
  });

  it('real people, agents, and dev scripts are NOT infrastructure (kept)', () => {
    expect(isInfraClient('poe', 'poe')).toBe(false);
    expect(isInfraClient('Claude-User', 'mcp')).toBe(false);
    expect(isInfraClient('llama-index', 'mcp')).toBe(false);
    expect(isInfraClient('python-httpx/0.28.1', 'mcp')).toBe(false);
  });
});

describe('networkKind — datacenter vs residential origin (the bot signal)', () => {
  it('cloud / hosting AS orgs are hosting', () => {
    for (const o of ['Amazon.com, Inc.', 'AMAZON-02', 'Google LLC', 'Microsoft Corporation', 'Hetzner Online GmbH', 'OVH SAS', 'DigitalOcean, LLC', 'Vultr Holdings', 'Oracle Corporation']) {
      expect(networkKind(o)).toBe('hosting');
    }
  });

  it('consumer ISPs are residential (= likely a real person)', () => {
    for (const o of ['Comcast Cable Communications', 'Verizon Business', 'AT&T Services, Inc.', 'T-Mobile USA', 'Charter Communications', 'Cox Communications']) {
      expect(networkKind(o)).toBe('residential');
    }
  });

  it('empty or unrecognized orgs are unknown, never assumed human', () => {
    expect(networkKind(null)).toBe('unknown');
    expect(networkKind('')).toBe('unknown');
    expect(networkKind('Some Regional Net ZZ-9')).toBe('unknown');
  });
});
