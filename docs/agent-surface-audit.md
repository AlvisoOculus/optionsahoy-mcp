# Agent-Surface Audit & Backlog

**Opened:** 2026-07-06. **Method:** four parallel code-grounded audits (tools; discovery/docs; protocols REST/A2A/mcpb; integration ecosystem). Every item cites `file:line`. Baseline is healthy: all 7 tools reachable on every protocol, enums/param-mapping consistent across integrations, output schemas match the calcs. Issues cluster into **correctness defects** (a tool states/returns something wrong), **consistency drift**, and **reach gaps**.

This is a living backlog. Status: `TODO` / `WIP` / `DONE` (PR #). Execute top-down within each priority band.

---

## P1 — Correctness defects (a tool can return or claim something wrong)

| ID | Status | Finding | Evidence | Fix |
|----|--------|---------|----------|-----|
| **D1** | DONE (PR #139) | `stateCode` is `^[A-Z]{2}$` with no enum -> a typo/unknown code silently yields **$0 state tax**, a plausible wrong number | `mcp-tools.ts:59` (`STATE_SCHEMA`); `state-tax.ts:168` (`if (!stateData) return 0`) | Validated against `STATE_CODES` (50 + DC, sourced from the tax tables) via `p.enum` in the parser (gates all protocols) + schema enum; regression test added |
| **D2** | DONE (PR #139) | The 4 growth tools omit `expectedGrowth`/`volatility` from `required`, but the parser throws when they're absent (unless a covered `ticker`); `STRICT_INPUT_NOTE` implies they're optional (backwards) | `mcp-tools.ts:881-885` etc. vs `calc-parsers.ts:47-53,62-68` | Rewrote `STRICT_INPUT_NOTE` to state the conditional-strict requirement ((growth AND vol) OR ticker). NOTE: chose the note over `anyOf` — the requirement is an AND-of-ORs (vol can also come from `volatilityDrag`), which `anyOf` can't express without falsely rejecting valid calls |
| **D3** | DONE (PR #139) | `concentration_analyze` validated a full `hedgeChoice` object the MCP handler never read; always returned a 30%-OTM 1yr *put* regardless of the collar/tenor passed | handler -> `calculate()`; `hedgeChoice` only in `buildCustomPlan` (`concentration.ts:772-777`) | **Threaded** (Andrew's call): `calculate()`'s `hedging` block now honors `hedgeChoice` (kind/protectionLevel/tenorYears + short call for a collar), identical pricing to `buildCustomPlan`'s hedge leg. `hedging` output extended (kind, protectionLevel, tenorYears, callStrike, callPrice, netPremium); input note updated. Regression test added. |
| **D4** | DONE (PR #139) | QSBS "**eight** statutory tests" in `GEMINI.md:14` + `README.md:42` + `mcpb/manifest.json:7,54` — calc has **six** (every other surface agrees) | `qsbs.ts` (6 gates); `mcp-tools.ts:731` "six" | s/eight/six/ done (+ fixed a leftover put/collar->three-structure in the manifest long_description) |
| **D5** | DONE (PR #139) | `qsbs_check` `partial`/`caveats` verdict descriptions are wrong (`partial` = sub-100% tier, not "unsure") | `mcp-tools.ts:702` vs `qsbs.ts:427-435` | Reworded: partial = sub-100% exclusion tier; caveats = an `unsure` test |
| **D6** | DONE (PR #139) | Bessembinder "96% of stocks underperform T-bills" miscited (actual ~58%; 96% is "collectively matched") | `mcp-resources.ts:159,164` | Reworded both the resource description and body |
| **D7** | DONE (PR #139) | `ticker` resolves growth but not vol for ~5 tickers (vols table subset of returns); `TICKER_SCHEMA` over-promises "AND a cached implied vol" | `calc-parsers.ts:34`; `trailing-vols` vs `trailing-returns` | Made the `TICKER_SCHEMA` claim conditional (~90 resolve a return, ~85 also resolve vol; a miss errors on the exact unresolved field). Table reconciliation left as a data task |

## P2 — Consistency / drift

| ID | Status | Finding | Evidence |
|----|--------|---------|----------|
| D8 | TODO | OpenAPI `version` stuck at 1.9.5 vs 1.9.6 everywhere; `build-mcpb.mjs` sync array omits `openapi.json`; test only checks it's a string | `openapi.json:7`; `build-mcpb.mjs:9` |
| D9 | TODO | A2A skill IDs != MCP tool names for 6/7 tools; `a2a.ts:45` comment claims they match -> cross-protocol delegation fails | `a2a.ts:61-140` vs `mcp-tools.ts` names |
| D10 | TODO | `AGENTS.md`/`README` undercount resources & prompts to "six", omit the equity-funding pair; README resource table (6) contradicts its prompt table (7) | `AGENTS.md:68`; `README.md:92-103` |
| D11 | TODO | OpenAPI `EquityFunding` tag referenced but undeclared | `openapi.json:311` vs `:24-53` |
| D12 | TODO | Version reporting inconsistent across surfaces; MCP `GET /mcp` descriptor has no `version` | `api/v1/index.ts:80`; `mcp.ts:45-53` |
| D13 | TODO | `protective_put_price` output `inputs`-echo schema omits `spreadRiskLevel` (added the input, not the echo doc) | `mcp-tools.ts:559-571` |
| D14 | TODO | `concentration_analyze` silently accepts undocumented `volatilityDrag` input | `calc-parsers.ts:39-40` vs schema |
| D15 | TODO | `equity_funding_plan` uses the no-ticker strict note despite per-stack ticker growth resolution | `mcp-tools.ts:1367`; `calc-parsers.ts:298` |
| D16 | TODO | REST returns compute failures as 400 (indistinguishable from validation 400) | `api.ts:87-101` |
| D17 | TODO | Stale hygiene: `mcp.ts:6` "six tools" header; test-count drift (157+ vs 172); em-dashes in `AGENTS.md:73-78` | — |
| D18 | TODO | README hides shipped work: Zed, ACI.dev, OpenRouter unlinked; no `integrations/README.md` index | `README.md:53-70` |

## P3 — First-call-success opportunities (high leverage, mostly small)

| ID | Status | Finding | Effort |
|----|--------|---------|--------|
| O1 | TODO | Server `instructions` never mention the `ticker` auto-fill shortcut (biggest first-call lever) — `mcp.ts:128` | S |
| O2 | TODO | Surface per-tool output schemas + request/response examples into OpenAPI (`result` is bare `{}` today) | M |
| O3 | TODO | Structured error codes `{code, field, message}` instead of free-text on every surface | M |
| O4 | TODO | A `covered_tickers` resource/enum so agents stop guessing and eating round-trips | S |
| O5 | TODO | Prompts: demote `volatility` to optional + add `ticker` arg; default `cashReturnRate`; optional `terminationDate` when employed | S |

## P4 — Reach / adoption

| ID | Status | Finding | Effort / reach |
|----|--------|---------|------|
| O6 | TODO | Ship a JS/TS adapter (Vercel AI SDK / Mastra / LangChain.js) — biggest untapped audience, TS is the schema SoT, lists on npm | M / highest |
| O7 | TODO | OpenAI Agents SDK + Pydantic AI wrappers (~110 lines each) — now-default frameworks, zero coverage | S each / high |
| O8 | TODO | Close free listings: submit built Zed extension, publish n8n template, finish a2aregistry / awesome-a2a / ACI | S / registry traffic |
| O9 | TODO | One orchestration prompt (`plan-my-equity`) or a "how to combine tools" block | S-M |
| O10 | TODO | Codegen or a single `/openapi.json` conformance test to stop 8+ hand-maintained wrapper schemas drifting | M / structural |

---

## Notes
- **Web repo** owns a few surfaces (`for-agents`, `use-from-ai-assistants`, `llms.txt`, `openapi.json` mirror) — those were found consistent/complete; the drift is in the MCP-repo docs (`AGENTS.md`, `GEMINI.md`, `README.md`).
- `concentration_analyze`'s put/collar hedge option is intentionally two-structure (no spread there) — not a defect.
- Fixes land as focused PRs per priority band. Update Status + PR # here as each ships.
