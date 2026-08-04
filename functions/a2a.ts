// AlphaLatitude Inc. © 2026
//
// POST /a2a: Agent2Agent (A2A) JSON-RPC endpoint for the OptionsAhoy
// Equity Planner. Handles the `message/send` method by routing the message
// to one of the eight keyless calculators (see functions/_lib/a2a.ts). No
// language model is invoked, so there is no per-call inference cost.
//
// GET /a2a returns the Agent Card (a convenience; the canonical discovery
// location is the static /.well-known/agent-card.json).

import { CORS_HEADERS as BASE_CORS, type PagesContext, type PagesFunction } from './_lib/api';
import { logCall, logSample } from './_lib/stats';
import { AGENT_VERSION, buildAgentCard, handleMessage, type A2APart } from './_lib/a2a';

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

  // Every call completes synchronously (deterministic calculators, no queue),
  // so tasks/get has nothing to look up: per the A2A spec, unknown task id is
  // error -32001. Captured samples showed real 0.2-era clients calling the
  // task lifecycle and bouncing off method-not-found.
  if (body.method === 'tasks/get' || body.method === 'tasks/cancel') {
    logCall(context, { endpoint: 'a2a', isError: false, errorMsg: `legacy ${String(body.method)}` });
    return rpcError(
      body.id,
      -32001,
      'Task not found: this agent completes every call synchronously and does not persist tasks. ' +
        'Send "message/send" (or legacy "tasks/send") and read the result directly.',
    );
  }

  // Observed in production (7d): rpc.discover x4, SendMessage x1,
  // agent/getAuthenticatedExtendedCard x1. All are real client conventions,
  // not junk, and all were counted as errors.
  if (body.method === 'agent/getAuthenticatedExtendedCard' || body.method === 'agent/getExtendedCard') {
    // We serve one public card and require no auth, so the extended card is
    // the same card.
    logCall(context, { endpoint: 'a2a', isError: false, errorMsg: `card via ${String(body.method)}` });
    return rpcResult(body.id, buildAgentCard());
  }
  if (body.method === 'rpc.discover') {
    // OpenRPC service discovery: answer with the methods we actually support
    // rather than a method-not-found.
    logCall(context, { endpoint: 'a2a', isError: false, errorMsg: 'rpc.discover' });
    return rpcResult(body.id, {
      openrpc: '1.2.6',
      info: { title: 'OptionsAhoy Equity Planner (A2A)', version: AGENT_VERSION },
      methods: [
        { name: 'message/send', summary: 'Run a calculator from a data part, or keyword-route free text.' },
        { name: 'tasks/send', summary: 'Legacy alias of message/send; returns a completed Task.' },
        { name: 'tasks/get', summary: 'Not supported: every call completes synchronously.' },
        { name: 'agent/getAuthenticatedExtendedCard', summary: 'Returns the public Agent Card (no auth required).' },
      ],
    });
  }

  // Some clients send the method in PascalCase. Accept it rather than
  // bouncing a caller that is otherwise correct.
  const method = body.method === 'SendMessage' ? 'message/send' : body.method;
  const isLegacyTaskSend = method === 'tasks/send';
  if (method !== 'message/send' && !isLegacyTaskSend) {
    logCall(context, { endpoint: 'a2a', isError: true, errorMsg: `method ${String(body.method)}` });
    return rpcError(
      body.id,
      -32601,
      `Method not found: ${String(body.method)}. This agent supports "message/send" (and legacy "tasks/send").`,
    );
  }

  const params = body.params as { id?: unknown; message?: { parts?: unknown } } | undefined;
  const parts = params?.message?.parts;
  if (!Array.isArray(parts)) {
    return rpcError(body.id, -32602, 'Invalid params: expected params.message.parts to be an array.');
  }

  const handled = handleMessage(parts as A2APart[]);
  logCall(context, {
    endpoint: 'a2a',
    tool: handled.skill ?? undefined,
    isError: handled.isError,
    // The D1 column is error_msg; for non-error rows `detail` carries the
    // routing outcome so the endpoint drill-down can see it. Overload lives
    // here at the logging boundary, not in the domain type.
    errorMsg: handled.detail,
  });
  // Example capture (7-day rolling, admin-gated, infra-filtered in logSample):
  // this surface ran 30 days at a 75% no-route rate with zero captured
  // examples, so there was no way to see WHAT failed to route.
  logSample(context, {
    surface: 'a2a',
    tool: handled.skill ?? undefined,
    query: handled.query,
    answer: handled.message.parts
      .filter((p): p is A2APart & { text: string } => p.kind === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join(' '),
  });
  // Legacy tasks/send expects a Task object (id, terminal status, artifacts),
  // not a bare Message. Wrap the same reply: the task completes immediately.
  if (isLegacyTaskSend) {
    const taskId = typeof params?.id === 'string' ? params.id : crypto.randomUUID();
    return rpcResult(body.id, {
      id: taskId,
      // A real failure (unknown skill, invalid input, unrouted text) is a
      // failed task, not a completed one - the reply text says why.
      status: { state: handled.isError ? 'failed' : 'completed', timestamp: new Date().toISOString() },
      artifacts: [{ name: 'result', parts: handled.message.parts }],
    });
  }
  return rpcResult(body.id, handled.message);
};
