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
//   - which tickers are asked about, as daily counts (mcp_ticker_daily)
//
// If the MCP_STATS binding is not configured (local dev, tests, or before
// Andrew wires it in the Pages dashboard), logCall is a silent no-op.

import { isInfraClient, surfaceOf } from './classify';
import type { TickerUse } from './ticker-demand';

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
  /** Tickers the call named, folded into daily counts (see ticker-demand). */
  tickers?: TickerUse[];
}

const UA_MAX = 200;
const ERROR_MSG_MAX = 500;
const CLIENT_NAME_MAX = 100;
const GEO_MAX = 100;

interface CfGeo {
  country: string | null;
  region: string | null;
  city: string | null;
  asOrg: string | null;
  asn: number | null;
}

// Coarse geo + originating network of the REAL caller. The raw IP is never
// read or stored.
//
// Preference order: the x-oa-client-* headers stamped by the optionsahoy.com
// proxy worker (worker-proxy/src/index.ts) carry the caller's own cf metadata
// and win when present — this deployment's request.cf describes the WORKER's
// egress (always Cloudflare/Dallas), which blinded the stats to every real
// network behind the public domain. Direct pages.dev callers have no proxy
// hop, so their own request.cf is already correct (and a direct caller could
// spoof the x-oa-* headers — acceptable: this is telemetry, not auth).
// Country falls back to the cf-ipcountry header; every field is null when
// both sources are absent (local dev, tests).
function readCf(request: Request): CfGeo {
  const cf = (request as {
    cf?: { country?: string; region?: string; city?: string; asOrganization?: string; asn?: number };
  }).cf;
  const cut = (s: string | undefined | null) => (s ? String(s).slice(0, GEO_MAX) : null);
  const h = (name: string) => request.headers.get(name) ?? undefined;
  const fwdAsn = Number(h('x-oa-client-asn'));
  const country = h('x-oa-client-country') ?? cf?.country ?? request.headers.get('cf-ipcountry') ?? undefined;
  return {
    country: cut(country),
    region: cut(h('x-oa-client-region') ?? cf?.region),
    city: cut(h('x-oa-client-city') ?? cf?.city),
    asOrg: cut(h('x-oa-client-as-org') ?? cf?.asOrganization),
    asn: Number.isFinite(fwdAsn) && fwdAsn > 0 ? fwdAsn : typeof cf?.asn === 'number' ? cf.asn : null,
  };
}

const INSERT_SQL =
  'INSERT INTO mcp_calls (ts, endpoint, tool, is_error, error_msg, client_name, ua, country, as_org, asn, region, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// Write N call records in one D1 round-trip. Reads ua/country once (they
// are constant across a JSON-RPC batch). Uses db.batch() if the binding
// exposes it, falls back to per-statement run() otherwise. Single-row
// callers should use logCall().
export function logCalls(ctx: PagesContext, batch: CallFields[]): void {
  if (batch.length === 0) return;
  const db = ctx.env?.MCP_STATS;
  if (!db) return;
  const ua = ctx.request.headers.get('user-agent');
  const geo = readCf(ctx.request);
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
      geo.country,
      geo.asOrg,
      geo.asn,
      geo.region,
      geo.city,
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
  countTickers(ctx, db, batch, ua, ts);
}

const TICKER_UPSERT_SQL =
  'INSERT INTO mcp_ticker_daily (day, ticker, tool, outcome, n) VALUES (?, ?, ?, ?, 1) ' +
  'ON CONFLICT(day, ticker, tool, outcome) DO UPDATE SET n = n + 1';

// Fold the tickers these calls named into today's counts. Its own batch on
// purpose: a D1 batch is one transaction, so sharing the call-log batch would
// let a missing mcp_ticker_daily table (migration 0007 not applied) roll the
// call rows back with it. Our monitors and scanners are left out, as they are
// from the example capture, so the counts are demand and not our own probes.
function countTickers(ctx: PagesContext, db: D1Database, batch: CallFields[], ua: string | null, ts: number): void {
  const day = new Date(ts).toISOString().slice(0, 10);
  const stmts = batch.flatMap((f) =>
    !f.tickers?.length || isInfraClient(f.clientName ?? ua, surfaceOf(f.endpoint))
      ? []
      : f.tickers.map((t) => db.prepare(TICKER_UPSERT_SQL).bind(day, t.ticker, f.tool ?? f.endpoint, t.outcome)),
  );
  if (stmts.length === 0) return;
  const writes: Promise<unknown> = db.batch ? db.batch(stmts) : Promise.all(stmts.map((s) => s.run()));
  const promise = writes.catch(() => undefined);
  if (ctx.waitUntil) ctx.waitUntil(promise);
}

export function logCall(ctx: PagesContext, fields: CallFields): void {
  logCalls(ctx, [fields]);
}

// --- example capture (mcp_samples) -----------------------------------------
//
// A rolling 7-day sample of successful calls, for product feedback: which
// fields callers send, in what structure, per tool and client. It stores the
// SHAPE of the arguments only (field names and value types, array lengths),
// never a value, and never the answer. Until 2026-10-06 it kept the full
// query and answer text, i.e. users' share counts, income and holdings, which
// every public statement about the server (listings, tool descriptions, the
// privacy page) said was not retained; callShape is what makes that true.
// Admin-token-gated, pruned to 7 days on every write.

const SAMPLE_QUERY_MAX = 4000;
const SAMPLE_RETENTION_MS = 7 * 86_400_000; // 7 days rolling
const SHAPE_MAX_DEPTH = 6;
const SHAPE_MAX_KEYS = 60;
// A real argument name. Anything else is counted, not copied: a key is caller
// text too, and could carry a figure as easily as a value can.
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function shapeOf(v: unknown, depth: number): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    return depth >= SHAPE_MAX_DEPTH ? `array(${v.length})` : { items: v.length, of: shapeOf(v[0], depth + 1) };
  }
  if (typeof v === 'object') {
    if (depth >= SHAPE_MAX_DEPTH) return 'object';
    const out: Record<string, unknown> = {};
    let other = 0;
    for (const k of Object.keys(v as object).sort()) {
      if (!FIELD_NAME.test(k) || Object.keys(out).length >= SHAPE_MAX_KEYS) other++;
      else out[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1);
    }
    if (other > 0) out['(other keys)'] = other;
    return out;
  }
  return typeof v;
}

/**
 * What mcp_samples keeps of a call's arguments: their shape, never a value.
 * An object (or JSON text of one) becomes field names mapped to value types;
 * free text (a Poe or A2A message) becomes its word count.
 */
export function callShape(args: unknown): string | null {
  if (args === undefined) return null;
  let v = args;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      // not JSON: free text, handled below
    }
    if (typeof v === 'string' || v === null || typeof v !== 'object') {
      const words = String(args).trim() === '' ? 0 : String(args).trim().split(/\s+/).length;
      return `free text, ${words} words`;
    }
  }
  return JSON.stringify(shapeOf(v, 0)).slice(0, SAMPLE_QUERY_MAX);
}
const SAMPLE_INSERT_SQL =
  'INSERT INTO mcp_samples (ts, surface, tool, client_name, query, answer, country, region, city, as_org, asn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const SAMPLE_PRUNE_SQL = 'DELETE FROM mcp_samples WHERE ts < ?';

export interface SampleFields {
  surface: string; // poe | mcp | rest | a2a
  tool?: string;
  clientName?: string;
  /** The call's arguments (object, JSON text or free text). Only callShape(args) is stored. */
  args?: unknown;
}

// Write N example rows + prune the >7-day tail, in one fire-and-forget round
// trip. No-op when the MCP_STATS binding is absent.
export function logSamples(ctx: PagesContext, batch: SampleFields[]): void {
  if (batch.length === 0) return;
  const db = ctx.env?.MCP_STATS;
  if (!db) return;
  // REST/MCP calls carry no handshake client name; fall back to the request's
  // User-Agent so each example is attributable (curl/browser = a test, a real
  // integration's UA otherwise). Poe passes clientName 'poe' explicitly.
  const ua = ctx.request.headers.get('user-agent') ?? undefined;
  // Keep infrastructure noise (our own smoke suite + registry/scanner probes)
  // out of the 7-day example capture, so RECENT EXAMPLES shows real inputs.
  const kept = batch.filter((f) => !isInfraClient(f.clientName ?? ua, f.surface));
  if (kept.length === 0) return;
  const ts = Date.now();
  const geo = readCf(ctx.request);
  const stmts = kept.map((f) => {
    const client = f.clientName ?? ua;
    return db.prepare(SAMPLE_INSERT_SQL).bind(
      ts,
      f.surface,
      f.tool ?? null,
      client ? client.slice(0, CLIENT_NAME_MAX) : null,
      callShape(f.args),
      null, // answer: never stored (see callShape)
      geo.country,
      geo.region,
      geo.city,
      geo.asOrg,
      geo.asn,
    );
  });
  stmts.push(db.prepare(SAMPLE_PRUNE_SQL).bind(ts - SAMPLE_RETENTION_MS));
  const writes: Promise<unknown> = db.batch ? db.batch(stmts) : Promise.all(stmts.map((s) => s.run()));
  const promise = writes.catch(() => undefined);
  if (ctx.waitUntil) ctx.waitUntil(promise);
}

export function logSample(ctx: PagesContext, fields: SampleFields): void {
  logSamples(ctx, [fields]);
}
