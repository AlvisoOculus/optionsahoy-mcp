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
// @cloudflare/workers-types.
export type PagesFunction = (context: { request: Request }) => Promise<Response> | Response;

// Canonical FilingStatus literal values, mirrors the FilingStatus type in
// lib/tax/types.ts. Used by 5 of the 6 calculator endpoints; the calc
// inputs themselves keep the type-level union, this is the runtime array.
export const FILING_STATUSES = ['single', 'married_joint', 'head_household'] as const;

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

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
export async function runCalc<I, O>(
  request: Request,
  parseInput: (raw: unknown) => I,
  compute: (input: I) => O,
): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed. Use POST.' });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON in request body.' });
  }
  let input: I;
  try {
    input = parseInput(raw);
  } catch (err) {
    return jsonResponse(400, {
      error: `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  try {
    const output = compute(input);
    return jsonResponse(200, { ok: true, result: output });
  } catch (err) {
    return jsonResponse(400, {
      error: `Calculation failed: ${err instanceof Error ? err.message : String(err)}`,
    });
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

export const p = {
  num(o: Obj, k: string): number {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`field "${k}" must be a finite number`);
    }
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
    if (typeof v !== 'string') throw new Error(`field "${k}" must be an ISO date string`);
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`field "${k}" is not a valid date`);
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
  optNum(o: Obj, k: string): number | undefined {
    return o[k] === undefined ? undefined : p.num(o, k);
  },
};
