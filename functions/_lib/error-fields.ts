// AlphaLatitude Inc. © 2026
//
// Extracts the offending input field from a calculator error message, for the
// admin dashboard's "which required inputs do callers most often omit or botch"
// friction signal. Most parser errors lead with `field "<name>" ...` (either
// `... required` or `... must be <X>`, see functions/_lib/api.ts), but some
// structural ones do not (`either "stacks" or legacy "lots" ... required`,
// `lots[i] must be an object ...` from calc-parsers.ts). So rather than anchor
// on a leading `field "`, we scan the quoted tokens left to right and take the
// first that reduces to a real tool-input field (allowlist). The allowlist both
// picks the offending field out of a message that also quotes a ticker, and
// drops garbage field names a fuzzer might inject. Messages with no quoted
// field name (`body must be a JSON object`) are not attributed.

import { TOOLS } from './mcp-tools';

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

function collectFieldNames(schema: JsonSchema | undefined, into: Set<string>): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      into.add(name);
      collectFieldNames(sub, into);
    }
  }
  if (schema.items) collectFieldNames(schema.items, into);
}

// Every property name (including nested ones like lots[].shares) across all tool
// input schemas. Computed once at module load; the allowlist for extraction.
export const TOOL_INPUT_FIELDS: ReadonlySet<string> = (() => {
  const names = new Set<string>();
  for (const t of TOOLS) collectFieldNames(t.inputSchema as JsonSchema, names);
  return names;
})();

// Scan the quoted tokens in an error message left to right and return the first
// that reduces to a known input field, or null if none does. Array/nested paths
// collapse to the leaf (`stacks[0].expectedAnnualGrowth` -> `expectedAnnualGrowth`)
// so per-index variants aggregate together. The first-allowlisted-wins rule
// picks the omitted field out of messages that also quote a ticker (the field is
// named before the ticker in every parser message), and skips leading quoted
// tokens that are not fields.
export function extractRequiredField(
  errorMsg: string | null | undefined,
  allow: ReadonlySet<string> = TOOL_INPUT_FIELDS,
): string | null {
  if (!errorMsg) return null;
  const candidates: string[] = [];
  // A leading bareword field token catches the unquoted structural errors:
  // `lots[2] must be an object ...`, `stacks[3].lots must be a non-empty array`.
  const lead = /^([A-Za-z][A-Za-z0-9]*)(?:\[\d+\])?[.\s]/.exec(errorMsg);
  if (lead) candidates.push(lead[1]);
  // Quoted tokens catch `field "shares" ...` and `either "stacks" or "lots" ...`.
  for (const m of errorMsg.matchAll(/"([^"]+)"/g)) candidates.push(m[1]);
  for (const c of candidates) {
    const leaf = c.replace(/\[\d+\]/g, '').split('.').pop();
    if (leaf && allow.has(leaf)) return leaf;
  }
  return null;
}

export interface ErrorFieldRow {
  errorMsg: string;
  n: number;
}

// Aggregate pre-grouped error rows into a ranked field-omission list. Rows whose
// message names no allowlisted field are dropped (not bucketed as "other"): the
// point is an actionable list of real fields, not a total.
export function rankErrorFields(rows: ErrorFieldRow[], limit = 15): { field: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const r of rows) {
    const field = extractRequiredField(r.errorMsg);
    if (!field) continue;
    tally.set(field, (tally.get(field) ?? 0) + r.n);
  }
  return [...tally.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field))
    .slice(0, limit);
}
