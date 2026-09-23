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
import { warmForCall } from './calc-parsers';
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
import { encodeScenario, withScenario } from './scenario';

// Per-endpoint next-step block for REST responses. REST is the highest-volume
// tool surface (roughly 10x MCP tools/call) and until now returned bare
// {ok, result} - no free-tool link, no related endpoint, no beta pointer.
// Short by design: three strings per endpoint, so agents can cache or ignore
// it. The one input-dependent part is the scenario payload appended to
// web_tool for scenario-capable calculators (see restNextSteps below); every
// other field is the same on every call.
// Slugs match functions/api/v1/<slug>.ts and the web calculator paths.
export const REST_NEXT_STEPS: Record<string, { web_tool: string; also_run: string[]; beta: string }> = (() => {
  // Only the src abbreviation and the related-endpoint list are real data;
  // web_tool/beta URLs derive from them so the slug invariant is structural.
  const SPEC: Record<string, { src: string; also_run: string[] }> = {
    'amt-iso': { src: 'amt_iso', also_run: ['/api/v1/qsbs', '/api/v1/concentration', '/api/v1/nso'] },
    nso: { src: 'nso', also_run: ['/api/v1/concentration', '/api/v1/amt-iso'] },
    'rsu-sell-vs-hold': { src: 'rsu', also_run: ['/api/v1/rsu-lot-order', '/api/v1/concentration'] },
    concentration: { src: 'concentration', also_run: ['/api/v1/protective-put', '/api/v1/rsu-lot-order', '/api/v1/equity-funding'] },
    'protective-put': { src: 'put', also_run: ['/api/v1/concentration'] },
    qsbs: { src: 'qsbs', also_run: ['/api/v1/amt-iso', '/api/v1/concentration'] },
    'equity-funding': { src: 'funding', also_run: ['/api/v1/rsu-lot-order', '/api/v1/concentration', '/api/v1/rsu-sell-vs-hold'] },
    'rsu-lot-order': { src: 'lot_order', also_run: ['/api/v1/equity-funding', '/api/v1/concentration'] },
  };
  return Object.fromEntries(
    Object.entries(SPEC).map(([slug, { src, also_run }]) => [slug, {
      web_tool: `https://optionsahoy.com/tools/${slug}?src=rest_${src}`,
      also_run,
      beta: `https://optionsahoy.com/beta?src=rest_${src}`,
    }]),
  );
})();

// The next-step block for one REST response. Identical to the constant above
// except that a scenario-capable calculator gets the caller's own inputs
// carried to the web tool (and its own `_sc` src bucket, so the funnel can
// tell the two arrivals apart). REST bodies and MCP tool arguments are the
// same shape - both surfaces feed the same parser - so one web-side mapper
// serves both.
function restNextSteps(slug: string, raw: unknown): (typeof REST_NEXT_STEPS)[string] | undefined {
  const base = REST_NEXT_STEPS[slug];
  if (!base) return undefined;
  const scenario = encodeScenario(slug, raw);
  if (!scenario) return base;
  return { ...base, web_tool: withScenario(base.web_tool, scenario) };
}

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
  const slug = endpoint.startsWith('rest:') ? endpoint.slice(5) : endpoint;
  // Warm the published market data before parsing. The parsers are synchronous
  // (they are shared verbatim with the MCP, A2A and Poe surfaces), so the async
  // fetches have to happen here, at the request boundary, and the parser reads
  // the warmed memos. Never throws: a failed warm just means a `ticker`
  // resolves no volatility (the ordinary required-field error path) or no
  // chain (flat pricing, disclosed). Memoized for five minutes, so this is a
  // no-op on all but the first call in each window.
  //
  // LAZY: null entirely when this request provably reads neither memo -
  // explicit `volatility`, no `ticker`, or a tool with no ticker→sigma path.
  // Those requests were paying a cold-memo CDN round-trip for a value nothing
  // would read. See warmForCall for how the condition is derived.
  await warmForCall(slug, raw);
  let input: I;
  try {
    input = parseInput(raw);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Report every field the caller left out, not just the first one. See
    // allMissingFields: one round trip instead of one per field.
    const all = allMissingFields(parseInput as (raw: unknown) => unknown, raw, errorMsg);
    logCall(context, { endpoint, isError: true, errorMsg: `parse: ${errorMsg}` });
    return jsonResponse(400, {
      error: `Invalid input: ${all.join(' | ')}`,
      code: 'invalid_input',
      ...(all.length > 1 ? { missing_or_invalid: all } : {}),
    });
  }
  try {
    const output = compute(input);
    logCall(context, { endpoint, isError: false });
    logSample(context, {
      surface: 'rest',
      tool: slug,
      query: safeStringify(raw),
      answer: safeStringify(output),
    });
    const nextSteps = restNextSteps(slug, raw);
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

// Hoisted from p.num (hot path): a quoted number with optional $ and STRICT
// thousands-grouped commas. "0,3" (European decimal) must NOT match - it
// would silently 10x the value.
const NUM_STRING_RE = /^\s*\$?-?([0-9]+|[0-9]{1,3}(,[0-9]{3})+)(\.[0-9]+)?\s*$/;
const NUM_STRIP_RE = /[$,\s]/g;

// Collecting mode for the field parsers.
//
// The parsers are fail-fast: the first bad field throws and the caller learns
// about exactly that one. For an agent filling a form it has never seen, that
// is one HTTP round trip per missing field. Building one valid
// concentration_analyze call by hand on 2026-09-22 took five
// (acquisitionDate -> sector -> stateCode -> ordinaryIncome -> totalAssets),
// and the same shape shows up in production: tools/call ran a 33% error rate
// over 14 days, with the top error fields being omissions — volatility 96,
// expectedGrowth 49, expectedPositionReturn 29, targetDate 28.
//
// So after a parse fails, we run it a SECOND time with `collected` armed. In
// that pass the p.* helpers record their complaint and return a benign
// placeholder instead of throwing, so the parser keeps walking and every other
// missing field surfaces too. The happy path never enters this mode: one
// failed parse is the entry condition, and a successful parse is untouched.
let collected: string[] | null = null;

// Placeholders are chosen to be VALID for the field's own type so they do not
// trip a downstream check and invent a complaint about a field the caller got
// right. `date` returns today because several parsers bound a date to
// "today or later".
function fail<T>(message: string, placeholder: T): T {
  if (collected === null) throw new Error(message);
  collected.push(message);
  return placeholder;
}

const FIELD_NAME_RE = /^field "([^"]+)"/;

// Re-run `parse` collecting every field complaint, and return the message list
// to report: the original fail-fast message first, then one line per field the
// caller did not supply at all.
//
// The nullish filter is the conservative half. A placeholder can in principle
// provoke a complaint about a field that WAS supplied (a cross-field rule
// comparing two dates, say), and blaming a field the caller got right is worse
// than saying less — so only absent fields are added.
//
// Honest caveat: no parser today actually triggers that. Removing this line
// leaves every test passing, so treat it as insurance against the cross-field
// rules parsers accumulate, not as a guard something currently needs. If it
// ever costs more than it earns, it can go.
export function allMissingFields(parse: (raw: unknown) => unknown, raw: unknown, firstMessage: string): string[] {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Obj) : {};
  const messages = [firstMessage];
  const outer = collected;
  collected = [];
  try {
    parse(raw);
  } catch {
    // A non-field check (or a placeholder the parser refuses outright) can
    // still throw. Whatever it collected before that point still counts.
  }
  const found = collected ?? [];
  collected = outer;
  for (const m of found) {
    const name = m.match(FIELD_NAME_RE)?.[1];
    if (!name) continue;
    if (obj[name] != null) continue;
    if (messages.some((existing) => existing.startsWith(`field "${name}"`))) continue;
    messages.push(m);
  }
  return messages;
}

function checkBounds(k: string, v: number, b?: Bounds): number {
  if (b?.min !== undefined && v < b.min) {
    return fail(`field "${k}" must be >= ${b.min}`, b.min);
  }
  if (b?.max !== undefined && v > b.max) {
    return fail(`field "${k}" must be <= ${b.max}`, b.max);
  }
  return v;
}

export const p = {
  num(o: Obj, k: string, b?: Bounds): number {
    let v = o[k];
    // Tolerant reader: LLM callers routinely quote numbers ("150000",
    // "$150,000"). "must be a finite number" was the single largest real
    // input-error class across MCP + REST (admin stats, 30d), and every such
    // string is unambiguous, so coerce instead of bouncing the call.
    // "150k", "1e5 shares", "", and "0,3" (see NUM_STRING_RE) still throw.
    if (typeof v === 'string' && NUM_STRING_RE.test(v)) {
      v = Number(v.replace(NUM_STRIP_RE, ''));
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return checkBounds(k, fail(`field "${k}" must be a finite number`, b?.min ?? 0), b);
    }
    return checkBounds(k, v, b);
  },
  int(o: Obj, k: string, b?: Bounds): number {
    const v = p.num(o, k, b);
    if (!Number.isInteger(v)) return fail(`field "${k}" must be a whole number`, Math.round(v));
    return v;
  },
  str(o: Obj, k: string): string {
    const v = o[k];
    if (typeof v !== 'string') return fail(`field "${k}" must be a string`, '');
    return v;
  },
  bool(o: Obj, k: string): boolean {
    const v = o[k];
    if (typeof v !== 'boolean') return fail(`field "${k}" must be a boolean`, false);
    return v;
  },
  date(o: Obj, k: string): Date {
    const v = o[k];
    // Name the expected format in both error paths: a model that gets the
    // bare "not a valid date" tends to retry with another bad guess, while
    // an example self-corrects in one round trip.
    if (typeof v !== 'string') return fail(`field "${k}" must be an ISO date string like "2028-06-30"`, new Date());
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return fail(`field "${k}" is not a valid date; use ISO format like "2028-06-30"`, new Date());
    return d;
  },
  optDate(o: Obj, k: string): Date | null {
    return o[k] == null ? null : p.date(o, k);
  },
  enum<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
    const v = o[k];
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      return fail(`field "${k}" must be one of: ${allowed.join(', ')}`, allowed[0]);
    }
    return v as T;
  },
  optNum(o: Obj, k: string, b?: Bounds): number | undefined {
    return o[k] === undefined ? undefined : p.num(o, k, b);
  },
};
