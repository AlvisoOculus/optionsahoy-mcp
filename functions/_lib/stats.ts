// AlphaLatitude Inc. © 2026
//
// Async per-call logger for the MCP server and REST endpoints. Writes one
// row per inbound call into the MCP_STATS D1 binding via ctx.waitUntil
// (fire-and-forget so the response is never blocked on the write).
//
// Args are NOT logged. Only enough metadata to answer:
//   - which tools are being called and how often
//   - which clients (initialize.clientInfo.name) are connecting
//   - what's erroring and where
//   - rough geo + UA distribution
//
// If the MCP_STATS binding is not configured (local dev, tests, or before
// Andrew wires it in the Pages dashboard), logCall is a silent no-op.

// Minimal D1 surface we use. Full type lives in @cloudflare/workers-types
// which we deliberately don't pull in (would force one for the whole repo
// just to keep this file's types narrow). Match D1 by structural typing.
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(colName?: string): Promise<T | null>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  // Optional: D1 in production exposes this for atomic multi-statement
  // writes; test mocks may omit it and fall back to per-statement run().
  batch?(stmts: D1PreparedStatement[]): Promise<unknown>;
}

export interface Env {
  MCP_STATS?: D1Database;
  ADMIN_TOKEN?: string;
}

// EventContext subset that functions/_lib uses. env and waitUntil are
// optional so existing unit tests can pass `{ request }` without breaking.
export interface PagesContext {
  request: Request;
  env?: Env;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface CallFields {
  endpoint: string;
  tool?: string;
  isError: boolean;
  errorMsg?: string;
  clientName?: string;
}

const UA_MAX = 200;
const ERROR_MSG_MAX = 500;
const CLIENT_NAME_MAX = 100;

const INSERT_SQL =
  'INSERT INTO mcp_calls (ts, endpoint, tool, is_error, error_msg, client_name, ua, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

// Write N call records in one D1 round-trip. Reads ua/country once (they
// are constant across a JSON-RPC batch). Uses db.batch() if the binding
// exposes it, falls back to per-statement run() otherwise. Single-row
// callers should use logCall().
export function logCalls(ctx: PagesContext, batch: CallFields[]): void {
  if (batch.length === 0) return;
  const db = ctx.env?.MCP_STATS;
  if (!db) return;
  const ua = ctx.request.headers.get('user-agent');
  const country = ctx.request.headers.get('cf-ipcountry');
  const truncUa = ua ? ua.slice(0, UA_MAX) : null;
  const ts = Date.now();
  const stmts = batch.map((f) =>
    db.prepare(INSERT_SQL).bind(
      ts,
      f.endpoint,
      f.tool ?? null,
      f.isError ? 1 : 0,
      f.errorMsg ? f.errorMsg.slice(0, ERROR_MSG_MAX) : null,
      f.clientName ? f.clientName.slice(0, CLIENT_NAME_MAX) : null,
      truncUa,
      country,
    ),
  );
  const writes: Promise<unknown> =
    stmts.length === 1
      ? stmts[0].run()
      : db.batch
        ? db.batch(stmts)
        : Promise.all(stmts.map((s) => s.run()));
  const promise = writes.catch(() => undefined);
  if (ctx.waitUntil) ctx.waitUntil(promise);
}

export function logCall(ctx: PagesContext, fields: CallFields): void {
  logCalls(ctx, [fields]);
}
