// AlphaLatitude Inc. © 2026
//
// End-to-end test of the local stdio MCP server: spawn it, send a
// JSON-RPC handshake + tools/list + tools/call over stdin, parse
// responses from stdout. Validates that the stdio entry point exposes
// the same TOOLS surface as the hosted HTTP endpoint.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '..', 'src', 'stdio-server.ts');

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

async function runStdioSession(
  requests: Array<Record<string, unknown>>,
  expectedResponseCount: number,
): Promise<JsonRpcResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', SERVER_ENTRY], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses: JsonRpcResponse[] = [];
    let buffer = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for ${expectedResponseCount} responses; got ${responses.length}`));
    }, 10000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // ignore non-JSON debug lines
        }
        if (responses.length >= expectedResponseCount) {
          clearTimeout(timeout);
          child.kill();
          resolve(responses);
        }
      }
    });

    child.stderr.on('data', () => {});
    child.on('error', reject);

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
  });
}

describe('local stdio MCP server', () => {
  it('handshakes, lists tools, and answers a tool call', async () => {
    const responses = await runStdioSession(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'qsbs_check',
            arguments: {
              acquisitionDate: '2020-01-15',
              saleDate: '2026-06-01',
              entityType: 'us-c-corp',
              acquisitionMethod: 'original-issuance',
              assetCategory: 'under-50m',
              industry: 'tech-software',
              activeBusiness: 'yes',
              adjustedBasis: 100000,
              expectedGain: 5000000,
              stateCode: 'CA',
              ordinaryIncome: 250000,
              filingStatus: 'single',
            },
          },
        },
      ],
      3,
    );

    expect(responses).toHaveLength(3);

    // initialize
    const init = responses.find((r) => r.id === 1)!;
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');

    // tools/list returns six tools
    const list = responses.find((r) => r.id === 2)!;
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'amt_iso_optimize',
      'concentration_analyze',
      'nso_calculate',
      'protective_put_price',
      'qsbs_check',
      'rsu_sell_vs_hold',
    ]);

    // tools/call qsbs_check returns a verdict
    const call = responses.find((r) => r.id === 3)!;
    const content = (call.result as { content: Array<{ type: string; text: string }> }).content[0].text;
    const parsed = JSON.parse(content);
    expect(parsed.verdict).toBe('qualifies');
    expect(parsed.exclusionPercent).toBe(1);
  }, 15000);
});
