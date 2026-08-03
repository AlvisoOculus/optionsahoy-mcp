// AlphaLatitude Inc. © 2026
//
// Shared helpers for the /api/v1/* REST endpoints. The underscore prefix
// on _lib/ tells Cloudflare Pages this is not a routable function.
//
// CORS is wide-open because the calculators are public, free, and have no
// auth or state. Agents from any origin can call them. If we add rate
// limiting or auth later, this is the place to tighten.

// Cloudflare Pages Functions ambient type. Declared here so per-endpoint
// files don't each re-declare it just to avoid pulling in
// @cloudflare/workers-types. env and waitUntil are optional so tests can
// drive handlers with `{ request }` alone; in production CF always
// supplies both.
import { type PagesContext } from './stats';
export type PagesFunction = (context: PagesContext) => Promise<Response> | Response;
export type { PagesContext } from './stats';

// Canonical FilingStatus literal values, mirrors the FilingStatus type in
// lib/tax/types.ts. Used by 5 of the 6 calculator endpoints; the calc
// inputs themselves keep the type-level union, this is the runtime array.
export const FILING_STATUSES = ['single', 'married_joint', 'head_household'] as const;

// Shared CORS policy for the public, auth-less endpoints. Exported so the A2A
// endpoint can derive from the same origin/headers/max-age base (it only
// differs by also allowing GET). If we ever add rate limiting or auth, this is
// the single place to tighten.
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

// Best-effort JSON for example capture; never throws into the request path.
function safeStringify(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Parse and run a calculator. Returns the result as JSON on success, or
// a 400 with the error message if parsing / validation / the calc throws.
// Logs one row to MCP_STATS per inbound POST (preflight OPTIONS skipped).
import { logCall, logSample } from './stats';

// Per-endpoint next-step block for REST responses. REST is the highest-volume
// tool surface (roughly 10x MCP tools/call) and until now returned bare
// {ok, result} - no free-tool link, no related endpoint, no beta pointer.
// Constant and short by design: three strings per endpoint, same on every
// call, so agents can cache or ignore it; nothing here varies with the input.
// Slugs match functions/api/v1/<slug>.ts and the web calculator paths.
export const REST_NEXT_STEPS: Record<string, { web_tool: string; also_run: string[]; beta: string }> = {
  'amt-iso': {
    web_tool: 'https://optionsahoy.com/tools/amt-iso?src=rest_amt_iso',
    also_run: ['/api/v1/qsbs', '/api/v1/concentration', '/api/v1/nso'],
    beta: 'https://optionsahoy.com/beta?src=rest_amt_iso',
  },
  nso: {
    web_tool: 'https://optionsahoy.com/tools/nso?src=rest_nso',
    also_run: ['/api/v1/concentration', '/api/v1/amt-iso'],
    beta: 'https://optionsahoy.com/beta?src=rest_nso',
  },
  'rsu-sell-vs-hold': {
    web_tool: 'https://optionsahoy.com/tools/rsu-sell-vs-hold?src=rest_rsu',
    also_run: ['/api/v1/rsu-lot-order', '/api/v1/concentration'],
    beta: 'https://optionsahoy.com/beta?src=rest_rsu',
  },
  concentration: {
    web_tool: 'https://optionsahoy.com/tools/concentration?src=rest_concentration',
    also_run: ['/api/v1/protective-put', '/api/v1/rsu-lot-order', '/api/v1/equity-funding'],
    beta: 'https://optionsahoy.com/beta?src=rest_concentration',
  },
  'protective-put': {
    web_tool: 'https://optionsahoy.com/tools/protective-put?src=rest_put',
    also_run: ['/api/v1/concentration'],
    beta: 'https://optionsahoy.com/beta?src=rest_put',
  },
  qsbs: {
    web_tool: 'https://optionsahoy.com/tools/qsbs?src=rest_qsbs',
    also_run: ['/api/v1/amt-iso', '/api/v1/concentration'],
    beta: 'https://optionsahoy.com/beta?src=rest_qsbs',
  },
  'equity-funding': {
    web_tool: 'https://optionsahoy.com/tools/equity-funding?src=rest_funding',
    also_run: ['/api/v1/rsu-lot-order', '/api/v1/concentration', '/api/v1/rsu-sell-vs-hold'],
    beta: 'https://optionsahoy.com/beta?src=rest_funding',
  },
  'rsu-lot-order': {
    web_tool: 'https://optionsahoy.com/tools/rsu-lot-order?src=rest_lot_order',
    also_run: ['/api/v1/equity-funding', '/api/v1/concentration'],
    beta: 'https://optionsahoy.com/beta?src=rest_lot_order',
  },
};

export async function runCalc<I, O>(
  context: PagesContext,
  endpoint: string,
  parseInput: (raw: unknown) => I,
  compute: (input: I) => O,
): Promise<Response> {
  const { request } = context;
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') {
    logCall(context, { endpoint, isError: true, errorMsg: `method ${request.method}` });
    return jsonResponse(405, { error: 'Method not allowed. Use POST.' });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    logCall(context, { endpoint, isError: true, errorMsg: 'invalid json' });
    return jsonResponse(400, { error: 'Invalid JSON in request body.' });
  }
  let input: I;
  try {
    input = parseInput(raw);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logCall(context, { endpoint, isError: true, errorMsg: `parse: ${errorMsg}` });
    return jsonResponse(400, { error: `Invalid input: ${errorMsg}`, code: 'invalid_input' });
  }
  try {
    const output = compute(input);
    logCall(context, { endpoint, isError: false });
    logSample(context, {
      surface: 'rest',
      tool: endpoint.replace(/^rest:/, ''),
      query: safeStringify(raw),
      answer: safeStringify(output),
    });
    const nextSteps = REST_NEXT_STEPS[endpoint.replace(/^rest:/, '')];
    return jsonResponse(
      200,
      nextSteps ? { ok: true, result: output, next_steps: nextSteps } : { ok: true, result: output },
    );
  } catch (err) {
    // The input already parsed and validated, so a throw here is a server-side
    // computation failure, not a caller error - surface it as 5xx so agents
    // can distinguish "fix your request" (4xx) from "retry / report" (5xx).
    const errorMsg = err instanceof Error ? err.message : String(err);
    logCall(context, { endpoint, isError: true, errorMsg: `calc: ${errorMsg}` });
    return jsonResponse(500, { error: `Calculation failed: ${errorMsg}`, code: 'computation_error' });
  }
}

// Strongly-typed field parsers used by per-calc input parsers. Each throws
// with a `field "<name>" must be <X>` message that's surfaced to the caller
// in the 400 response. Keeps per-endpoint wrappers small.

export type Obj = Record<string, unknown>;

export function asObject(raw: unknown): Obj {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('body must be a JSON object');
  }
  return raw as Obj;
}

// Inclusive numeric bounds, mirroring the `minimum`/`maximum` declared on each
// field in the public JSON schema (functions/_lib/mcp-tools.ts). Passing these
// makes the REST endpoints enforce the same contract the MCP tools already
// advertise, instead of computing on out-of-range inputs (e.g. negative shares).
export type Bounds = { min?: number; max?: number };

function checkBounds(k: string, v: number, b?: Bounds): number {
  if (b?.min !== undefined && v < b.min) {
    throw new Error(`field "${k}" must be >= ${b.min}`);
  }
  if (b?.max !== undefined && v > b.max) {
    throw new Error(`field "${k}" must be <= ${b.max}`);
  }
  return v;
}

export const p = {
  num(o: Obj, k: string, b?: Bounds): number {
    let v = o[k];
    // Tolerant reader: LLM callers routinely quote numbers ("150000",
    // "$150,000"). "must be a finite number" was the single largest real
    // input-error class across MCP + REST (admin stats, 30d), and every such
    // string is unambiguous, so coerce instead of bouncing the call. Only a
    // string that is EXACTLY one plain number (optional $, thousands commas)
    // coerces; "150k", "1e5 shares", "" still throw.
    if (typeof v === 'string' && /^\s*\$?-?[0-9][0-9,]*(\.[0-9]+)?\s*$/.test(v)) {
      v = Number(v.replace(/[$,\s]/g, ''));
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`field "${k}" must be a finite number`);
    }
    return checkBounds(k, v, b);
  },
  int(o: Obj, k: string, b?: Bounds): number {
    const v = p.num(o, k, b);
    if (!Number.isInteger(v)) throw new Error(`field "${k}" must be a whole number`);
    return v;
  },
  str(o: Obj, k: string): string {
    const v = o[k];
    if (typeof v !== 'string') throw new Error(`field "${k}" must be a string`);
    return v;
  },
  bool(o: Obj, k: string): boolean {
    const v = o[k];
    if (typeof v !== 'boolean') throw new Error(`field "${k}" must be a boolean`);
    return v;
  },
  date(o: Obj, k: string): Date {
    const v = o[k];
    // Name the expected format in both error paths: a model that gets the
    // bare "not a valid date" tends to retry with another bad guess, while
    // an example self-corrects in one round trip.
    if (typeof v !== 'string') throw new Error(`field "${k}" must be an ISO date string like "2028-06-30"`);
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`field "${k}" is not a valid date; use ISO format like "2028-06-30"`);
    return d;
  },
  optDate(o: Obj, k: string): Date | null {
    return o[k] == null ? null : p.date(o, k);
  },
  enum<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
    const v = o[k];
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      throw new Error(`field "${k}" must be one of: ${allowed.join(', ')}`);
    }
    return v as T;
  },
  optNum(o: Obj, k: string, b?: Bounds): number | undefined {
    return o[k] === undefined ? undefined : p.num(o, k, b);
  },
};
