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
  // Optional because most existing test mocks don't implement it. The
  // sessions helper guards before calling. Real D1 always provides it.
  first?<T = unknown>(colName?: string): Promise<T | null>;
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

// --- example capture (mcp_samples) -----------------------------------------
//
// A rolling 7-day sample of real inputs+outputs, for product feedback. UNLIKE
// the metadata-only mcp_calls table, this stores query+answer text (financial
// details), so it is admin-token-gated, pruned to 7 days on every write, and
// only written for successful calls. See db/migrations/0003_mcp_samples.sql.

const SAMPLE_QUERY_MAX = 4000;
const SAMPLE_ANSWER_MAX = 8000;
const SAMPLE_RETENTION_MS = 7 * 86_400_000; // 7 days rolling
const SAMPLE_INSERT_SQL =
  'INSERT INTO mcp_samples (ts, surface, tool, client_name, query, answer) VALUES (?, ?, ?, ?, ?, ?)';
const SAMPLE_PRUNE_SQL = 'DELETE FROM mcp_samples WHERE ts < ?';

export interface SampleFields {
  surface: string; // poe | mcp | rest
  tool?: string;
  clientName?: string;
  query?: string;
  answer?: string;
}

// Write N example rows + prune the >7-day tail, in one fire-and-forget round
// trip. No-op when the MCP_STATS binding is absent.
export function logSamples(ctx: PagesContext, batch: SampleFields[]): void {
  if (batch.length === 0) return;
  const db = ctx.env?.MCP_STATS;
  if (!db) return;
  const ts = Date.now();
  const cut = (s: string | undefined, max: number) => (s ? s.slice(0, max) : null);
  const stmts = batch.map((f) =>
    db.prepare(SAMPLE_INSERT_SQL).bind(
      ts,
      f.surface,
      f.tool ?? null,
      f.clientName ? f.clientName.slice(0, CLIENT_NAME_MAX) : null,
      cut(f.query, SAMPLE_QUERY_MAX),
      cut(f.answer, SAMPLE_ANSWER_MAX),
    ),
  );
  stmts.push(db.prepare(SAMPLE_PRUNE_SQL).bind(ts - SAMPLE_RETENTION_MS));
  const writes: Promise<unknown> = db.batch ? db.batch(stmts) : Promise.all(stmts.map((s) => s.run()));
  const promise = writes.catch(() => undefined);
  if (ctx.waitUntil) ctx.waitUntil(promise);
}

export function logSample(ctx: PagesContext, fields: SampleFields): void {
  logSamples(ctx, [fields]);
}
