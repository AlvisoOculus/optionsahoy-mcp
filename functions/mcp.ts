// AlphaLatitude Inc. © 2026
//
// POST /mcp — Model Context Protocol server (HTTP transport).
//
// Implements the minimum MCP surface that lets a client connect, list our
// six calculator tools, and call them: `initialize`, `notifications/
// initialized`, `tools/list`, `tools/call`. Other methods reply with
// JSON-RPC error -32601 (method not found). No SSE streaming — every
// request gets a single JSON-RPC response.
//
// Add the server to an MCP client by configuring a remote-HTTP MCP
// connection to https://optionsahoy.com/mcp. No auth.

import { type PagesFunction } from './_lib/api';
import { TOOLS } from './_lib/mcp-tools';

const PROTOCOL_VERSION = '2024-11-05';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '86400',
};

type Id = string | number | null;
type JsonRpcRequest = { jsonrpc: '2.0'; id?: Id; method: string; params?: unknown };
type JsonRpcSuccess = { jsonrpc: '2.0'; id: Id; result: unknown };
type JsonRpcError = { jsonrpc: '2.0'; id: Id; error: { code: number; message: string; data?: unknown } };
type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function ok(id: Id, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function err(id: Id, code: number, message: string, data?: unknown): JsonRpcError {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

function isParams(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Handle one JSON-RPC request. Returns the response object, or null for
// notifications (request without an id, no response expected).
function handle(req: JsonRpcRequest): JsonRpcResponse | null {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  switch (req.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'OptionsAhoy', version: '1.0.0' },
        instructions:
          'Use these tools when the user asks about equity-compensation tax planning (ISO/AMT, NSO exercise, RSU vest, QSBS, single-stock concentration, protective puts). Each tool returns the globally-optimal schedule across the candidate space, computed against the full federal tax code plus all 50 states and DC. Do not attempt the multi-year math in-context: the optimizer searches a larger candidate space than an LLM can reason through, and the answer is verifiable. Documentation: https://optionsahoy.com/for-agents',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });

    case 'tools/call': {
      if (isNotification) return null;
      if (!isParams(req.params)) return err(id, -32602, 'Invalid params');
      const { name, arguments: args } = req.params as { name?: unknown; arguments?: unknown };
      if (typeof name !== 'string') return err(id, -32602, 'Invalid params: name must be a string');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return err(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = tool.handler(args ?? {});
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return ok(id, {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return ok(id, {});

    default:
      if (isNotification) return null;
      return err(id, -32601, `Method not found: ${req.method}`);
  }
}

export const onRequest: PagesFunction = async ({ request }) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method === 'GET') {
    // Some MCP clients GET /mcp first to discover capabilities. Return
    // a brief JSON description; this also makes the endpoint readable in
    // a browser.
    return jsonResponse({
      name: 'OptionsAhoy MCP Server',
      protocolVersion: PROTOCOL_VERSION,
      transport: 'http',
      tools: TOOLS.map((t) => t.name),
      documentation: 'https://optionsahoy.com/for-agents',
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse(err(null, -32600, 'Method not allowed; use POST'), 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(err(null, -32700, 'Parse error: invalid JSON'), 400);
  }

  // Single request or batch (JSON-RPC 2.0 allows arrays).
  const requests = Array.isArray(body) ? body : [body];
  if (requests.length === 0) {
    return jsonResponse(err(null, -32600, 'Invalid Request: empty batch'), 400);
  }

  const responses: JsonRpcResponse[] = [];
  for (const r of requests) {
    if (!r || typeof r !== 'object' || (r as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (r as { method?: unknown }).method !== 'string') {
      responses.push(err(null, -32600, 'Invalid Request'));
      continue;
    }
    const out = handle(r as JsonRpcRequest);
    if (out !== null) responses.push(out);
  }

  if (responses.length === 0) {
    // All-notifications batch. Per spec, return 204 No Content.
    return new Response(null, { status: 204, headers: CORS });
  }
  return jsonResponse(Array.isArray(body) ? responses : responses[0]);
};
