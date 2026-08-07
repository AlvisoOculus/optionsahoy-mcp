// AlphaLatitude Inc. © 2026
//
// POST /mcp — Model Context Protocol server (HTTP transport).
//
// Implements the MCP surface that lets a client connect, list our eight
// calculator tools (plus resources and prompts), and call them: `initialize`,
// `notifications/initialized`, `tools/list`, `tools/call`, `resources/list`,
// `resources/read`, `prompts/list`, `prompts/get`. Other methods reply with
// JSON-RPC error -32601 (method not found). No SSE streaming: every request
// gets a single JSON-RPC response.
//
// Add the server to an MCP client by configuring a remote-HTTP MCP
// connection to https://optionsahoy.com/mcp. No auth.

import { type PagesFunction } from './_lib/api';
import { logCalls, logSamples, type CallFields, type SampleFields, type D1Database } from './_lib/stats';
import { TOOLS } from './_lib/mcp-tools';
import { RESOURCES } from './_lib/mcp-resources';
import { PROMPTS } from './_lib/mcp-prompts';
import { BARE_CALL_COUNT, bumpSessionCallCount, nextStepsFor } from './_lib/sessions';
import { isInfraClient } from './_lib/classify';
import { SERVER_VERSION } from './_lib/version';
import { SERVER_INSTRUCTIONS } from './_lib/mcp-instructions';
import { coveredTickers } from '../lib/data/trailing-returns';

const PROTOCOL_VERSION = '2024-11-05';

// Precomputed projections for the list endpoints. These fire on every MCP
// client connect; doing the .map() once at module load avoids reallocating
// on each request.
const TOOLS_LIST = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  outputSchema: t.outputSchema,
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
  version: SERVER_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  transport: 'http' as const,
  tools: TOOLS.map((t) => t.name),
  resources: RESOURCES.map((r) => r.uri),
  prompts: PROMPTS.map((p) => p.name),
  // The covered public symbols the `ticker` auto-fill resolves. Enumerable here
  // (not as an 8th resource) so agents/tooling can list the set without probing.
  // Live from the bundled ETL snapshot, so it tracks each deploy.
  coveredTickers: coveredTickers(),
  documentation: 'https://optionsahoy.com/for-agents',
};

// The descriptor never changes at runtime, so serialize it once at module load
// instead of re-stringifying (now including the coveredTickers array)
// on every GET /mcp hit - this endpoint is polled heavily by scanners/registries.
const GET_DESCRIPTOR_JSON = JSON.stringify(GET_DESCRIPTOR);

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version',
  // Without expose-headers, browser-based clients (MCP Inspector web, registry
  // try-it panes) can receive the session id below but never READ it, so they
  // would stay sessionless forever and the next-steps funnel would stay dark
  // for that whole client class.
  'access-control-expose-headers': 'mcp-session-id',
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

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extraHeaders },
  });
}

function isParams(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Dispatch one JSON-RPC request. Pushes one CallFields entry into `logs`
// per handled method (notifications are skipped because they carry no
// actionable signal). The caller flushes `logs` to D1 in one batch.
//
// `sessionDeps` carries the Mcp-Session-Id + MCP_STATS binding so that
// tools/call can dedupe its injected beta-access pitch per session.
// `injectSessionless` covers the much larger population that never echoes a
// session id (MCP SDK integrations calling tools/call directly): they get the
// bare, un-deduped form. Both undefined/false = no injection at all.
async function handle(
  req: JsonRpcRequest,
  logs: CallFields[],
  samples: SampleFields[],
  sessionDeps: { sessionId: string; db: D1Database } | undefined,
  allowInjection: boolean,
): Promise<JsonRpcResponse | null> {
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
        serverInfo: { name: 'OptionsAhoy', version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
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
        const result = tool.handler(args ?? {}) as Record<string, unknown>;
        logs.push({ endpoint, tool: name, isError: false });
        // Capture this successful call as an example (7-day rolling, admin-gated).
        // Stringify the result now, before next_steps injection, so it stays clean.
        try {
          samples.push({ surface: 'mcp', tool: name, query: JSON.stringify(args ?? {}), answer: JSON.stringify(result) });
        } catch {
          // never let example capture break the tool response
        }
        // Inject the next-step conversion block (free tool -> complementary
        // tool -> beta) as a top-level `next_steps` field. It lived at
        // `_meta.optionsahoy` until 2026-08; a protocol-namespaced key read as
        // bookkeeping, so assistants paraphrased the prose pitch in the tool
        // description and dropped the links entirely. The full block fires only
        // on the first tools/call per session; later calls get the bare
        // free-tool URL via nextStepsFor() so a multi-tool query doesn't read
        // as repeated pitches.
        // Sessionless callers get the same block in its bare, un-deduped form
        // (BARE_CALL_COUNT): no session means no way to dedupe, so they never
        // get the once-per-session beta pitch and never a join token. This
        // path exists because production disproved the original assumption
        // that sessionless traffic is all scanners: in a 7-day window 928 of
        // 942 valid tool calls arrived without a session, and the non-infra
        // sample of those is entirely MCP SDK integrations (python-httpx,
        // node). Infra callers are filtered out by the caller, so registry
        // probes still get clean, unmarketed responses.
        if (sessionDeps || allowInjection) {
          try {
            // Only the session bump can fail; sessionless callers take the
            // bare count and nothing here throws.
            const count = sessionDeps
              ? await bumpSessionCallCount(sessionDeps.db, sessionDeps.sessionId)
              : BARE_CALL_COUNT;
            const next = nextStepsFor(name, count, sessionDeps?.sessionId, args);
            if (next) result.next_steps = next;
          } catch {
            // Session tracking failure must never break the tool response.
          }
        }
        // Per MCP spec, tools that declare an outputSchema return the result
        // object as `structuredContent` plus a backwards-compatible
        // serialized text block.
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
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

  // Pull the session ID + D1 binding once so handle() can dedupe the
  // beta-access pitch per session. undefined if either is missing —
  // tools/call then skips injection entirely.
  const sessionId = request.headers.get('Mcp-Session-Id');
  const db = ctx.env?.MCP_STATS;
  const sessionDeps = sessionId && db ? { sessionId, db } : undefined;
  // Whether this caller may be shown the next-steps block at all. Excludes
  // infrastructure (registry probes, scanners, our own smoke) via the same
  // predicate the example capture uses. Deliberately broader than
  // isRealClient(): an SDK caller reporting a bare script UA is still worth a
  // free-tool link, even though it is not counted as a named connect.
  const allowInjection = !isInfraClient(request.headers.get('user-agent'), 'mcp');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method === 'GET') {
    // Some MCP clients GET /mcp first to discover capabilities. Return
    // a brief JSON description; this also makes the endpoint readable in
    // a browser.
    logs.push({ endpoint: 'mcp:GET', isError: false });
    logCalls(ctx, logs);
    return new Response(GET_DESCRIPTOR_JSON, {
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }
  if (request.method === 'HEAD') {
    // Health checkers and uptime monitors HEAD /mcp (290 hits/30d, previously
    // logged as bad-method errors). Answer like GET but bodyless, as a
    // non-error.
    logs.push({ endpoint: 'mcp:HEAD', isError: false });
    logCalls(ctx, logs);
    return new Response(null, {
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }
  if (request.method === 'DELETE') {
    // Spec-compliant clients DELETE /mcp on shutdown to end their session.
    // We keep no per-session server state beyond a D1 counter, so there is
    // nothing to terminate; the spec allows a plain 405 for servers that do
    // not support client-initiated termination. Logged as a non-error so
    // clean client shutdowns do not pollute the error stats.
    logs.push({ endpoint: 'mcp:session-delete', isError: false });
    logCalls(ctx, logs);
    return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } });
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

  // Issue a session id at initialization (streamable-HTTP: the server MAY
  // assign one; compliant clients then echo it on every later request). This
  // is what arms the per-session next-steps dedup in tools/call: before this,
  // the server never issued an id, no client ever echoed one, and the
  // free-tool/related-tool/beta block effectively never fired (9 sessions
  // recorded against ~62k calls). We issue-and-do-NOT-enforce: sessionless
  // requests keep working unchanged, so scanners and curl are unaffected.
  const hasInitialize = requests.some(
    (r) => !!r && typeof r === 'object' && (r as { method?: unknown }).method === 'initialize',
  );
  const issuedSessionId = hasInitialize ? (sessionId ?? crypto.randomUUID()) : undefined;
  const sessionHeader = issuedSessionId ? { 'mcp-session-id': issuedSessionId } : undefined;

  const responses: JsonRpcResponse[] = [];
  const samples: SampleFields[] = [];
  for (const r of requests) {
    if (!r || typeof r !== 'object' || (r as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (r as { method?: unknown }).method !== 'string') {
      logs.push({ endpoint: 'mcp:invalid-request', isError: true });
      responses.push(err(null, -32600, 'Invalid Request'));
      continue;
    }
    const out = await handle(r as JsonRpcRequest, logs, samples, sessionDeps, allowInjection);
    if (out !== null) responses.push(out);
  }

  logCalls(ctx, logs);
  logSamples(ctx, samples);

  if (responses.length === 0) {
    // All-notifications batch. Per spec, return 204 No Content.
    return new Response(null, { status: 204, headers: CORS });
  }
  return jsonResponse(Array.isArray(body) ? responses : responses[0], 200, sessionHeader);
};
