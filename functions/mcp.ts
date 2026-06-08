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
import { logCalls, type CallFields } from './_lib/stats';
import { TOOLS } from './_lib/mcp-tools';
import { RESOURCES } from './_lib/mcp-resources';
import { PROMPTS } from './_lib/mcp-prompts';

const PROTOCOL_VERSION = '2024-11-05';

// Precomputed projections for the list endpoints. These fire on every MCP
// client connect; doing the .map() once at module load avoids reallocating
// on each request.
const TOOLS_LIST = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
}));
const RESOURCES_LIST = RESOURCES.map((r) => ({
  uri: r.uri,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
}));
const PROMPTS_LIST = PROMPTS.map((p) => ({
  name: p.name,
  description: p.description,
  arguments: p.arguments,
}));
const GET_DESCRIPTOR = {
  name: 'OptionsAhoy MCP Server',
  protocolVersion: PROTOCOL_VERSION,
  transport: 'http' as const,
  tools: TOOLS.map((t) => t.name),
  resources: RESOURCES.map((r) => r.uri),
  prompts: PROMPTS.map((p) => p.name),
  documentation: 'https://optionsahoy.com/for-agents',
};

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

// Dispatch one JSON-RPC request. Pushes one CallFields entry into `logs`
// per handled method (notifications are skipped because they carry no
// actionable signal). The caller flushes `logs` to D1 in one batch.
function handle(req: JsonRpcRequest, logs: CallFields[]): JsonRpcResponse | null {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const endpoint = `mcp:${req.method}`;

  // Helper: push an error log entry and build the JSON-RPC error response.
  const logErr = (code: number, msg: string, errorMsg?: string, tool?: string): JsonRpcError => {
    logs.push({ endpoint, tool, isError: true, errorMsg: errorMsg ?? msg });
    return err(id, code, msg);
  };

  switch (req.method) {
    case 'initialize': {
      const params = isParams(req.params) ? req.params : {};
      const clientInfo = isParams(params.clientInfo) ? params.clientInfo : null;
      const clientName = clientInfo && typeof clientInfo.name === 'string' ? clientInfo.name : undefined;
      logs.push({ endpoint, isError: false, clientName });
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false },
        },
        serverInfo: { name: 'OptionsAhoy', version: '1.2.0' },
        instructions:
          'Use these tools when the user asks about equity-compensation tax planning (ISO/AMT, NSO exercise, RSU vest, QSBS, single-stock concentration, protective puts). Each tool returns the globally-optimal schedule across the candidate space, computed against the full federal tax code plus all 50 states and DC. Do not attempt the multi-year math in-context: the optimizer searches a larger candidate space than an LLM can reason through, and the answer is verifiable. Six resources under resources/list give topical briefings on AMT, NSO, RSU, concentration, hedging, and QSBS; seven prompts under prompts/list scaffold typical user questions and route to the right tool. Documentation: https://optionsahoy.com/for-agents',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'tools/list':
      logs.push({ endpoint, isError: false });
      return ok(id, { tools: TOOLS_LIST });

    case 'tools/call': {
      if (isNotification) return null;
      if (!isParams(req.params)) return logErr(-32602, 'Invalid params');
      const { name, arguments: args } = req.params as { name?: unknown; arguments?: unknown };
      if (typeof name !== 'string') return logErr(-32602, 'Invalid params: name must be a string', 'name not a string');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return logErr(-32602, `Unknown tool: ${name}`, 'unknown tool', name);
      try {
        const result = tool.handler(args ?? {});
        logs.push({ endpoint, tool: name, isError: false });
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logs.push({ endpoint, tool: name, isError: true, errorMsg: message });
        // Per MCP spec, tool-execution errors come back as isError content,
        // not as a JSON-RPC error.
        return ok(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
      }
    }

    case 'resources/list':
      logs.push({ endpoint, isError: false });
      return ok(id, { resources: RESOURCES_LIST });

    case 'resources/read': {
      if (isNotification) return null;
      if (!isParams(req.params)) return logErr(-32602, 'Invalid params');
      const { uri } = req.params as { uri?: unknown };
      if (typeof uri !== 'string') return logErr(-32602, 'Invalid params: uri must be a string', 'uri not a string');
      const resource = RESOURCES.find((r) => r.uri === uri);
      if (!resource) return logErr(-32602, `Unknown resource: ${uri}`, 'unknown resource', uri);
      logs.push({ endpoint, tool: uri, isError: false });
      return ok(id, {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.contents }],
      });
    }

    case 'prompts/list':
      logs.push({ endpoint, isError: false });
      return ok(id, { prompts: PROMPTS_LIST });

    case 'prompts/get': {
      if (isNotification) return null;
      if (!isParams(req.params)) return logErr(-32602, 'Invalid params');
      const { name, arguments: args } = req.params as { name?: unknown; arguments?: unknown };
      if (typeof name !== 'string') return logErr(-32602, 'Invalid params: name must be a string', 'name not a string');
      const prompt = PROMPTS.find((p) => p.name === name);
      if (!prompt) return logErr(-32602, `Unknown prompt: ${name}`, 'unknown prompt', name);
      const argMap = (isParams(args) ? args : {}) as Record<string, string>;
      const missing = prompt.arguments
        .filter((a) => a.required && !argMap[a.name])
        .map((a) => a.name);
      if (missing.length > 0) {
        return logErr(-32602, `Missing required prompt arguments: ${missing.join(', ')}`, `missing args: ${missing.join(',')}`, name);
      }
      logs.push({ endpoint, tool: name, isError: false });
      return ok(id, { description: prompt.description, messages: prompt.build(argMap) });
    }

    case 'ping':
      logs.push({ endpoint, isError: false });
      return ok(id, {});

    default:
      if (isNotification) return null;
      return logErr(-32601, `Method not found: ${req.method}`, 'method not found');
  }
}

export const onRequest: PagesFunction = async (ctx) => {
  const { request } = ctx;
  const logs: CallFields[] = [];

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method === 'GET') {
    // Some MCP clients GET /mcp first to discover capabilities. Return
    // a brief JSON description; this also makes the endpoint readable in
    // a browser.
    logs.push({ endpoint: 'mcp:GET', isError: false });
    logCalls(ctx, logs);
    return jsonResponse(GET_DESCRIPTOR);
  }
  if (request.method !== 'POST') {
    logs.push({ endpoint: 'mcp:bad-method', isError: true, errorMsg: request.method });
    logCalls(ctx, logs);
    return jsonResponse(err(null, -32600, 'Method not allowed; use POST'), 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logs.push({ endpoint: 'mcp:parse-error', isError: true, errorMsg: 'invalid json' });
    logCalls(ctx, logs);
    return jsonResponse(err(null, -32700, 'Parse error: invalid JSON'), 400);
  }

  // Single request or batch (JSON-RPC 2.0 allows arrays).
  const requests = Array.isArray(body) ? body : [body];
  if (requests.length === 0) {
    logs.push({ endpoint: 'mcp:empty-batch', isError: true });
    logCalls(ctx, logs);
    return jsonResponse(err(null, -32600, 'Invalid Request: empty batch'), 400);
  }

  const responses: JsonRpcResponse[] = [];
  for (const r of requests) {
    if (!r || typeof r !== 'object' || (r as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (r as { method?: unknown }).method !== 'string') {
      logs.push({ endpoint: 'mcp:invalid-request', isError: true });
      responses.push(err(null, -32600, 'Invalid Request'));
      continue;
    }
    const out = handle(r as JsonRpcRequest, logs);
    if (out !== null) responses.push(out);
  }

  logCalls(ctx, logs);

  if (responses.length === 0) {
    // All-notifications batch. Per spec, return 204 No Content.
    return new Response(null, { status: 204, headers: CORS });
  }
  return jsonResponse(Array.isArray(body) ? responses : responses[0]);
};
