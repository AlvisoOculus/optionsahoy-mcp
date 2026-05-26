// AlphaLatitude Inc. © 2026
//
// End-to-end test for the /mcp HTTP MCP server. Drives the handler with
// the same JSON-RPC requests an MCP client would send, then asserts:
//   - initialize negotiates protocol + advertises tools capability
//   - notifications/initialized returns no body (204 No Content)
//   - tools/list returns all 6 tools with input schemas
//   - tools/call invokes the right calc and the text content parses to
//     the same JSON the in-process call returns (byte-identity check)
//   - error paths: unknown method, unknown tool, malformed body, bad
//     HTTP method

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/mcp';
import { computeAmtIso } from '@/lib/calc/amtIso';
import { evaluateQsbs } from '@/lib/calc/qsbs';

function rpc(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/mcp', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

async function call<T = unknown>(body: unknown): Promise<{ status: number; json: T }> {
  const res = await onRequest({ request: rpc(body) });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : (null as unknown as T);
  return { status: res.status, json };
}

const AMT_ISO_INPUT = {
  shares: 5000,
  strike: 4,
  fmv: 90,
  expectedGrowth: 0.1,
  volatilityDrag: 0.2,
  filingStatus: 'single',
  ordinaryIncome: 250000,
  stateCode: 'CA',
  carryforwardCredit: 0,
  horizon: 4,
  cashReturnRate: 0.05,
  grantDate: '2024-05-20',
  hasLeftCompany: false,
  terminationDate: null,
};

const QSBS_INPUT = {
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

describe('POST /mcp — initialize', () => {
  it('returns protocol version + tools capability', async () => {
    const { status, json } = await call<{ result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } }>({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBe('2024-11-05');
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.serverInfo.name).toBe('OptionsAhoy');
  });
});

describe('POST /mcp — notifications', () => {
  it('returns 204 for notifications/initialized', async () => {
    const res = await onRequest({
      request: rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(204);
  });
});

describe('POST /mcp — tools/list', () => {
  it('lists 6 calculator tools, each with an inputSchema', async () => {
    const { json } = await call<{ result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } }>({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const names = json.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'amt_iso_optimize',
      'concentration_analyze',
      'nso_calculate',
      'protective_put_price',
      'qsbs_check',
      'rsu_sell_vs_hold',
    ]);
    for (const t of json.result.tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toBeDefined();
    }
  });
});

describe('POST /mcp — tools/call dispatches to the right calc', () => {
  it('amt_iso_optimize matches in-process computeAmtIso', async () => {
    const { json } = await call<{ result: { content: Array<{ type: string; text: string }>; isError?: boolean } }>({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'amt_iso_optimize', arguments: AMT_ISO_INPUT },
    });
    expect(json.result.isError).toBeFalsy();
    const text = json.result.content[0]!.text;
    const reference = computeAmtIso({
      ...AMT_ISO_INPUT,
      filingStatus: 'single',
      grantDate: new Date('2024-05-20'),
      terminationDate: null,
    } as Parameters<typeof computeAmtIso>[0]);
    expect(text).toEqual(JSON.stringify(reference));
  });

  it('qsbs_check matches in-process evaluateQsbs', async () => {
    const { json } = await call<{ result: { content: Array<{ text: string }>; isError?: boolean } }>({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'qsbs_check', arguments: QSBS_INPUT },
    });
    expect(json.result.isError).toBeFalsy();
    const text = json.result.content[0]!.text;
    const reference = evaluateQsbs({
      ...QSBS_INPUT,
      acquisitionDate: new Date('2020-03-01'),
      saleDate: new Date('2026-03-15'),
    } as Parameters<typeof evaluateQsbs>[0]);
    expect(text).toEqual(JSON.stringify(reference));
  });

  it('returns isError content for invalid arguments (does not crash)', async () => {
    const { json } = await call<{ result: { content: Array<{ text: string }>; isError?: boolean } }>({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'amt_iso_optimize', arguments: { shares: 'not a number' } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0]!.text).toMatch(/Error/);
  });

  it('returns JSON-RPC error for unknown tool', async () => {
    const { json } = await call<{ error: { code: number; message: string } }>({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toMatch(/Unknown tool/);
  });
});

describe('POST /mcp — error paths', () => {
  it('returns JSON-RPC -32601 for unknown method', async () => {
    const { json } = await call<{ error: { code: number } }>({
      jsonrpc: '2.0',
      id: 7,
      method: 'completely/made/up',
    });
    expect(json.error.code).toBe(-32601);
  });

  it('returns 400 + -32700 for malformed JSON', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32700);
  });

  it('returns 405 for non-POST/GET/OPTIONS', async () => {
    const res = await onRequest({
      request: new Request('http://localhost/mcp', { method: 'DELETE' }),
    });
    expect(res.status).toBe(405);
  });

  it('OPTIONS preflight returns CORS headers', async () => {
    const res = await onRequest({ request: rpc(null, 'OPTIONS') });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('GET returns server description JSON', async () => {
    const res = await onRequest({ request: rpc(null, 'GET') });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string; tools: string[] };
    expect(json.name).toMatch(/OptionsAhoy/);
    expect(json.tools.length).toBe(6);
  });
});

describe('POST /mcp — batch requests', () => {
  it('returns one response per request in the same order', async () => {
    const res = await onRequest({
      request: rpc([
        { jsonrpc: '2.0', id: 'a', method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
      ]),
    });
    const json = (await res.json()) as Array<{ id: string; result: unknown }>;
    expect(json).toHaveLength(2);
    expect(json[0]!.id).toBe('a');
    expect(json[1]!.id).toBe('b');
  });
});
