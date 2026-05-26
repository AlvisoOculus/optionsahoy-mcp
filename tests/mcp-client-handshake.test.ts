// AlphaLatitude Inc. © 2026
//
// Full MCP client-conversation regression test. Different concern from
// mcp-server.test.ts (which exercises each JSON-RPC method in isolation):
// this file walks the four-step handshake a real MCP client performs,
// in sequence, and asserts the things that would break a Claude Desktop
// / ChatGPT / Perplexity connection if they regressed.
//
// Step 1: initialize         — server must echo protocol version, declare tools capability
// Step 2: notifications/initialized — server must respond 204 No Content (200+body breaks some clients)
// Step 3: tools/list         — server must enumerate the tools the client will then call
// Step 4: tools/call         — server must dispatch + return content blocks
//
// Plus a drift catcher: every name in tools/list must dispatch when sent
// to tools/call. If someone adds a tool name to the catalog but typos
// the handler key, the dispatcher would return -32602 "Unknown tool"
// and a real client would silently fail with "tool not available".

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/mcp';

const PROTOCOL_VERSION = '2024-11-05';

function rpc(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function call<T>(body: unknown): Promise<T> {
  const res = await onRequest({ request: rpc(body) });
  return (await res.json()) as T;
}

// Known-good input for one tool, used in step 4 to verify end-to-end
// dispatch (handler → parser → calc → text content). qsbs is chosen
// because its inputs are closed (no implicit "today") so the assertion
// is fully deterministic across runs.
const QSBS_OK_INPUT = {
  acquisitionDate: '2020-03-01',
  saleDate: '2026-03-15',
  entityType: 'us-c-corp',
  acquisitionMethod: 'original-issuance',
  assetCategory: 'under-50m',
  industry: 'tech-software',
  activeBusiness: 'yes',
  adjustedBasis: 50000,
  expectedGain: 5000000,
  stateCode: 'CA',
  ordinaryIncome: 300000,
  filingStatus: 'single',
};

describe('MCP client-conversation regression', () => {
  it('completes the four-step handshake without breaking protocol', async () => {
    // ── Step 1: initialize ───────────────────────────────────────────────
    type InitResponse = {
      jsonrpc: '2.0';
      id: number;
      result: {
        protocolVersion: string;
        capabilities: { tools?: unknown };
        serverInfo: { name: string; version: string };
      };
    };
    const init = await call<InitResponse>({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'regression-test', version: '1.0' },
      },
    });
    expect(init.jsonrpc).toBe('2.0');
    expect(init.id).toBe(1);
    expect(init.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.result.capabilities.tools, 'server must declare tools capability or clients skip tools/list').toBeDefined();
    expect(init.result.serverInfo.name, 'serverInfo.name is displayed by some clients').toBeTruthy();
    expect(init.result.serverInfo.version).toBeTruthy();

    // ── Step 2: notifications/initialized ────────────────────────────────
    // MCP spec §JSON-RPC: notifications get no response. Servers that
    // return 200 with a body break clients that strict-parse this.
    const notif = await onRequest({
      request: rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notif.status, 'notifications must return 204 No Content, not 200+body').toBe(204);

    // ── Step 3: tools/list ───────────────────────────────────────────────
    type ListResponse = {
      result: {
        tools: Array<{ name: string; description: string; inputSchema: unknown }>;
      };
    };
    const list = await call<ListResponse>({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(list.result.tools.length, 'tools/list must not be empty').toBeGreaterThan(0);
    for (const t of list.result.tools) {
      expect(t.name, 'every tool must have a non-empty name').toBeTruthy();
      expect(t.description.length, `tool "${t.name}" description should be useful (>20 chars)`).toBeGreaterThan(20);
      expect(t.inputSchema, `tool "${t.name}" must declare an inputSchema or clients cannot build call args`).toBeDefined();
    }

    // ── Step 4: tools/call (one real tool, valid args) ──────────────────
    type CallResponse = {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    const callResp = await call<CallResponse>({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'qsbs_check', arguments: QSBS_OK_INPUT },
    });
    expect(callResp.result.isError, 'valid args must not be flagged as error').toBeFalsy();
    expect(callResp.result.content[0]!.type).toBe('text');
    const calcResult = JSON.parse(callResp.result.content[0]!.text) as {
      verdict: string;
      federalTaxSaved: number;
    };
    expect(calcResult.verdict).toBe('qualifies');
    expect(calcResult.federalTaxSaved).toBeGreaterThan(0);
  });

  it('every tool advertised in tools/list dispatches when called', async () => {
    // Drift catcher. If TOOLS[] in mcp-tools.ts adds a name but the
    // handler key is typo'd or removed elsewhere, tools/list would still
    // advertise the name and tools/call would return -32602 "Unknown
    // tool" — a real client silently drops the broken tool from its
    // menu, so this regression is otherwise invisible until a user
    // tries it.
    type ListResponse = { result: { tools: Array<{ name: string }> } };
    const list = await call<ListResponse>({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    for (const tool of list.result.tools) {
      type CallResponse =
        | { result: { content: Array<{ text: string }>; isError?: boolean } }
        | { error: { code: number; message: string } };
      const resp = await call<CallResponse>({
        jsonrpc: '2.0',
        id: tool.name,
        method: 'tools/call',
        params: { name: tool.name, arguments: {} },
      });
      if ('error' in resp) {
        throw new Error(
          `tools/list advertises "${tool.name}" but tools/call returned ${resp.error.code} "${resp.error.message}"`,
        );
      }
      // Expected: empty args fail parsing, so the handler wraps the
      // parse failure as isError content. This proves dispatch reached
      // the handler.
      expect(resp.result.isError, `tool "${tool.name}" should isError on empty args, not succeed`).toBe(true);
      expect(resp.result.content[0]!.text).toMatch(/Error/);
    }
  });
});
