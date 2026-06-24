# Agent-Output Test Audit Plan

Status: APPROVED 2026-06-24 (tests-first: build the scaffold so every defect surfaces as a
failing test, then fix under green). Companion: `agent-output-defects-2026-06-24.md` (the defect
inventory each test must lock down).

## Why this exists

A code-red audit (2026-06-24) found the calculation engine is correct and the tool-call JSON is
complete, but every layer that turns that JSON into words for an agent or a human was unguarded and
had drifted: the Poe prose formatter (`functions/poe.ts`), the MCP tool descriptions
(`functions/_lib/mcp-tools.ts`), the resources and prompts (`functions/_lib/mcp-resources.ts`,
`mcp-prompts.ts`), and the published agent docs (`web/public/llms.txt`, `llms-full.txt`,
`openapi.json`, `app/for-agents/page.tsx`). The existing suite only tests the calc engine, so the
answer layer rotted silently.

Principle: **bind every agent-facing string to the engine as the single source of truth.** An
answer must not be able to become incomplete, self-contradictory, or stale without a test failing.

## Surfaces in scope

- Poe bot answer text: `functions/poe.ts` (`headline()` + the full `handleQuery` flow)
- MCP: `functions/mcp.ts`, tool descriptions/schemas in `functions/_lib/mcp-tools.ts`
- MCP resources + prompts: `functions/_lib/mcp-resources.ts`, `functions/_lib/mcp-prompts.ts`
- REST API: `functions/api/v1/*` (wraps the same engine via `functions/_lib/api.ts`)
- Parsers: `functions/_lib/calc-parsers.ts`; engine + constants: `lib/calc/*`, `lib/tax/*`
- Published docs: `optionsahoy_web/web/public/{llms.txt,llms-full.txt,openapi.json}`,
  `web/app/for-agents/page.tsx` (cross-repo; keep the web/public copies in sync with source)

## Phases

### Phase 0 — Per-tool answer contracts (the spine)
One declarative module per tool (e.g. `tests/contracts/<tool>.contract.ts`) holding:
- `requiredFacts`: every datum the answer MUST surface, as predicates over the result JSON
  (e.g. equity_funding: each schedule row's date+shares, total shares, feasibility, total tax;
  amt: per-year schedule, NFV, creditRemaining; concentration: plan numbers, hedge cost,
  waitForLtInsight.savings).
- `discriminants`: every engine field that branches the answer and its full value set
  (qsbs.verdict 5 values; plan.feasible t/f; hold.isLongTerm t/f; timing.windowClosed; collar
  isZeroCost; recommended put|collar|none; bracketJump present; alreadyInAmt).
- `scenarios`: concrete arg sets that drive each discriminant value (feasible + infeasible goal,
  short + long hold, closed + open window, each verdict, etc.).
Everything below reads from this so coverage is declared once.

### Phase 1 — Completeness tests (the half-baked class)
For each tool x surface (Poe text, MCP text/structured, REST JSON): assert every `requiredFact`
appears. Plus a structural property test over generated scenarios: e.g. count of "sell N shares"
lines == number of schedule rows; the year-grouped fallback fires only past its threshold and its
totals still reconcile. Structurally kills hidden/summarized data.

### Phase 2 — Branch-exhaustiveness + no-contradiction
Each `discriminant` value gets a test asserting the headline matches that state and the body does
not contradict it. A meta-test fails if the formatter lands in a generic/default branch for any
enumerated value (catches caveats->default, infeasible->success, short-hold->"long-term rate").

### Phase 3 — Number reconciliation
Parse every dollar and percent out of the rendered answer and assert each equals its engine field.
Catches mislabeled figures and disclosed-assumption vs effective-value mismatches (e.g. discloses
$130 sale price but the comparison used the ~$111 haircut price).

### Phase 4 — Code <-> docs consistency (automated, no human reading)
- schema fields are a subset of parser-read fields; parser-required fields appear in schema
  `required`/`anyOf`; schema enums equal parser allowed lists.
- field names mentioned in a tool description exist in that tool's outputSchema/return type.
- enum strings in prose/descriptions equal engine enums (catches `does-not-qualify`).
- prompt argument names + required-input lists are satisfiable by the parser
  (catches analyze-nso-decision missing `holdYears>=1`; `state` vs `stateCode`; dead `shares` arg).
- every example call embedded in a description/doc executes successfully in CI.
- generated docs (`llms.txt`, `llms-full.txt`, `openapi.json`) regenerate clean: a `--check` mode
  fails on drift; openapi request schemas match parsers (add missing `ticker`, equity-funding
  `anyOf`); response-schema claim on /for-agents matches reality.
- the `web/public` copies match the source descriptors (toolspec duplication guard).

### Phase 5 — Fact-binding for static briefings (tax correctness)
Resources/prompts assert their hard tax facts against the same constants the calc uses, not free
text: OBBBA cutoff (`lib/calc/qsbs.ts` OBBBA_CUTOFF = 2025-07-04), the 50/75/100% tiers, the
"six statutory tests" count and ids, the non-conforming-state set (CA/AL/PA/MS; NJ conforms 2026+;
HI/MA partial), AMT rates 26/28, state-AMT set CA/CO/CT/MN, cap inflation-indexing from 2027.
Prose can no longer disagree with the engine. The few claims that are not engine-derivable (e.g.
the NSO break-even equivalence, the NVDA/QQQ correlation figure) are listed for manual correction.

### Phase 6 — Voice/IP lint + robustness
- Scanner over all agent-facing strings for em-dashes, emoji, testimonials, "$X savings", price
  sources (Polygon/Yahoo), and IP-leak patterns (source paths like `lib/...`, model names like
  Black-Scholes, search-strategy words like grid/greedy/refinement, magic constants like 1.20),
  with a deliberate allowlist for genuinely public references.
- Per-tool degraded-input tests: each missing/bad/out-of-range field returns a clean ask that
  names the correct field (catches the NSO "ask for price when volatility is missing" bug), never
  an engine stack trace, never an authorize-without-capture charge.

## Wiring

- Phases 1-3, 6 run in the existing `vitest` suite.
- Phase 4-5 consistency + fact-binding run in `vitest` and in the pre-commit hook.
- The doc `--check` regeneration and embedded-example execution run in CI.

## Sequencing

Build Phase 0 contracts first, then 1-3 (Poe answer correctness, highest user-facing risk), then 4
(stops doc drift to all agents), then 5 (tax-fact brand risk), then 6 (lint + robustness). Fix
defects under failing tests as each phase lands. QSBS spans the most criticals across bot, docs, and
resource, so its contract + fact-binding should be first within each phase.
