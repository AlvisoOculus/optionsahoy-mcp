// AlphaLatitude Inc. © 2026
//
// Integration test: drive functions/mcp.ts with a mock D1 binding and
// assert that handled JSON-RPC methods produce mcp_calls rows with the
// expected endpoint, tool, isError, and clientName fields.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/mcp';
import type { D1Database, D1PreparedStatement, Env } from '../functions/_lib/stats';

interface LoggedRow {
  ts: number;
  endpoint: string;
  tool: string | null;
  isError: number;
  errorMsg: string | null;
  clientName: string | null;
  ua: string | null;
  country: string | null;
}

function mockDb(): { db: D1Database; rows: LoggedRow[] } {
  const rows: LoggedRow[] = [];
  return {
    rows,
    db: {
      prepare(query: string): D1PreparedStatement {
        let bindings: unknown[] = [];
        const obj: D1PreparedStatement = {
          bind(...values: unknown[]) {
            bindings = values;
            return obj;
          },
          async run() {
            // Only record mcp_calls inserts; ignore the mcp_samples insert/prune
            // (example capture) so these metadata assertions stay focused.
            if (!query.startsWith('INSERT INTO mcp_calls')) return undefined;
            rows.push({
              ts: bindings[0] as number,
              endpoint: bindings[1] as string,
              tool: bindings[2] as string | null,
              isError: bindings[3] as number,
              errorMsg: bindings[4] as string | null,
              clientName: bindings[5] as string | null,
              ua: bindings[6] as string | null,
              country: bindings[7] as string | null,
            });
            return undefined;
          },
          async all<T = unknown>() { return { results: [] as T[] }; },
        };
        return obj;
      },
    },
  };
}

function rpc(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Claude-MCP/1.0' },
    body: JSON.stringify(body),
  });
}

async function flushedCall(
  body: unknown,
  env: Env,
): Promise<{ status: number; pendingWrites: Promise<unknown>[] }> {
  const pendingWrites: Promise<unknown>[] = [];
  const res = await onRequest({
    request: rpc(body),
    env,
    waitUntil: (p) => { pendingWrites.push(p); },
  });
  await Promise.all(pendingWrites);
  return { status: res.status, pendingWrites };
}

describe('mcp.ts -> logCall integration', () => {
  it('logs initialize with clientInfo.name', async () => {
    const { db, rows } = mockDb();
    await flushedCall(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Claude.ai', version: '1.0' } } },
      { MCP_STATS: db },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe('mcp:initialize');
    expect(rows[0].clientName).toBe('Claude.ai');
    expect(rows[0].isError).toBe(0);
    expect(rows[0].ua).toBe('Claude-MCP/1.0');
  });

  it('logs a successful tools/call with the tool name', async () => {
    const { db, rows } = mockDb();
    await flushedCall(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'qsbs_check',
          arguments: {
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
            ordinaryIncome: 200000,
            filingStatus: 'single',
          },
        },
      },
      { MCP_STATS: db },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe('mcp:tools/call');
    expect(rows[0].tool).toBe('qsbs_check');
    expect(rows[0].isError).toBe(0);
  });

  it('logs a tools/call validation failure with isError=1', async () => {
    const { db, rows } = mockDb();
    await flushedCall(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'concentration_analyze', arguments: { positionValue: 400000 } },
      },
      { MCP_STATS: db },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe('mcp:tools/call');
    expect(rows[0].tool).toBe('concentration_analyze');
    expect(rows[0].isError).toBe(1);
    expect(rows[0].errorMsg).toMatch(/required|must be/i);
  });

  it('logs an unknown tool with isError=1 and the tool name', async () => {
    const { db, rows } = mockDb();
    await flushedCall(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'made_up_tool', arguments: {} } },
      { MCP_STATS: db },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('made_up_tool');
    expect(rows[0].isError).toBe(1);
    expect(rows[0].errorMsg).toMatch(/unknown tool/);
  });

  it('logs tools/list, resources/list, prompts/list (passive scans)', async () => {
    const { db, rows } = mockDb();
    await flushedCall({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, { MCP_STATS: db });
    await flushedCall({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, { MCP_STATS: db });
    await flushedCall({ jsonrpc: '2.0', id: 7, method: 'prompts/list' }, { MCP_STATS: db });
    expect(rows.map((r) => r.endpoint)).toEqual([
      'mcp:tools/list',
      'mcp:resources/list',
      'mcp:prompts/list',
    ]);
    expect(rows.every((r) => r.isError === 0)).toBe(true);
  });

  it('does not log notifications (no id)', async () => {
    const { db, rows } = mockDb();
    await flushedCall(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { MCP_STATS: db },
    );
    expect(rows).toHaveLength(0);
  });

  it('still works when MCP_STATS is not bound', async () => {
    const { status } = await flushedCall(
      { jsonrpc: '2.0', id: 8, method: 'ping' },
      {},
    );
    expect(status).toBe(200);
  });

  it('batches all log rows from a JSON-RPC batch into one db.batch() call', async () => {
    const { db, rows } = mockDb();
    let batchCalls = 0;
    const dbWithBatch = {
      ...db,
      batch: async (stmts: { run(): Promise<unknown> }[]) => {
        batchCalls += 1;
        for (const s of stmts) await s.run();
      },
    };
    await flushedCall(
      [
        { jsonrpc: '2.0', id: 10, method: 'initialize', params: { clientInfo: { name: 'BatchClient' } } },
        { jsonrpc: '2.0', id: 11, method: 'tools/list' },
        { jsonrpc: '2.0', id: 12, method: 'ping' },
      ],
      { MCP_STATS: dbWithBatch },
    );
    expect(batchCalls).toBe(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.endpoint)).toEqual(['mcp:initialize', 'mcp:tools/list', 'mcp:ping']);
  });
});
