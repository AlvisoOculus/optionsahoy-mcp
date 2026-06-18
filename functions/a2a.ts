// AlphaLatitude Inc. © 2026
//
// POST /a2a: Agent2Agent (A2A) JSON-RPC endpoint for the OptionsAhoy
// Equity Planner. Handles the `message/send` method by routing the message
// to one of the seven keyless calculators (see functions/_lib/a2a.ts). No
// language model is invoked, so there is no per-call inference cost.
//
// GET /a2a returns the Agent Card (a convenience; the canonical discovery
// location is the static /.well-known/agent-card.json).

import { CORS_HEADERS as BASE_CORS, type PagesContext, type PagesFunction } from './_lib/api';
import { logCall } from './_lib/stats';
import { buildAgentCard, handleMessage, type A2APart } from './_lib/a2a';

// Same shared CORS base as the REST endpoints; this one also serves GET (the
// Agent Card), so it overrides only the allowed-methods line.
const CORS_HEADERS: Record<string, string> = {
  ...BASE_CORS,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// JSON-RPC 2.0 error envelope (HTTP 200; the error lives in the body).
function rpcError(id: unknown, code: number, message: string): Response {
  return json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function rpcResult(id: unknown, result: unknown): Response {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

export const onRequest: PagesFunction = async (context: PagesContext): Promise<Response> => {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return json(200, buildAgentCard());
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST for JSON-RPC or GET for the card.' });
  }

  let body: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return rpcError(null, -32700, 'Parse error: request body is not valid JSON.');
  }

  if (body === null || typeof body !== 'object' || body.jsonrpc !== '2.0') {
    return rpcError(body?.id, -32600, 'Invalid Request: expected a JSON-RPC 2.0 object.');
  }

  if (body.method !== 'message/send') {
    logCall(context, { endpoint: 'a2a', isError: true, errorMsg: `method ${String(body.method)}` });
    return rpcError(
      body.id,
      -32601,
      `Method not found: ${String(body.method)}. This agent supports "message/send".`,
    );
  }

  const params = body.params as { message?: { parts?: unknown } } | undefined;
  const parts = params?.message?.parts;
  if (!Array.isArray(parts)) {
    return rpcError(body.id, -32602, 'Invalid params: expected params.message.parts to be an array.');
  }

  const { message, skill } = handleMessage(parts as A2APart[]);
  logCall(context, { endpoint: 'a2a', tool: skill ?? undefined, isError: skill === null });
  return rpcResult(body.id, message);
};
