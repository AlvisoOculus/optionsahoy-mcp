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
| D8 | DONE (PR #140) | OpenAPI `version` stuck at 1.9.5 vs 1.9.6; `build-mcpb.mjs` sync array omitted `openapi.json`; test only checked it's a string | Bumped to 1.9.6; build:mcpb now syncs `info.version` textually; test asserts `info.version === package.json version` (drift fails CI) |
| D9 | DONE (PR #140) | A2A skill IDs != MCP tool names for 6/7 tools; `a2a.ts` comment claimed they match | **Aligned** (Andrew's call): renamed the 6 skill ids to their MCP tool names on the main A2A surface (+ regenerated static cards, updated tests, fixed the comment) and on the openbb-agent mirror (advertising layer only; internal dispatch names unchanged). A capability now carries one name across MCP / REST / A2A. |
| D10 | DONE (PR #140) | `AGENTS.md`/`README` undercount resources & prompts to "six", omit the equity-funding pair; README resource table (6) vs prompt table (7) | Corrected to seven + added the equity-funding resource row |
| D11 | DONE (PR #140) | OpenAPI `EquityFunding` tag referenced but undeclared | Tag declared |
| D12 | DONE (PR #140) | Version reporting inconsistent; MCP `GET /mcp` descriptor has no `version` | Added `version: SERVER_VERSION` to the MCP GET descriptor and `serverVersion` to `/api/v1` |
| D13 | DONE (PR #140) | `protective_put_price` output `inputs`-echo schema omits `spreadRiskLevel` | Added to the echo schema |
| D14 | DONE (PR #140) | `concentration_analyze` silently accepts undocumented `volatilityDrag` input | Documented it in the input schema (alternative to `volatility`) |
| D15 | DONE (PR #140) | `equity_funding_plan` uses the no-ticker strict note despite per-stack ticker growth resolution | Added a ticker-shortcut sentence to its description |
| D16 | DONE (PR #140) | REST returns compute failures as 400 (indistinguishable from validation 400) | Post-parse compute throws now return 500 |
| D17 | DONE (PR #140) | Stale hygiene: `mcp.ts` "six tools" header; test-count drift; em-dashes in `AGENTS.md` | Counts de-brittled, em-dashes removed |
| D18 | DONE (PR #140) | README hides shipped work: Zed, ACI.dev, OpenRouter unlinked; no `integrations/README.md` index | Added the three links + a new `integrations/README.md` index |
| D19 | DONE (this PR) | All adapters advertised an `equity_funding.today` override that the endpoint **ignores by design** (calc-parsers.ts:319-323, stale-training-cutoff defense); `openapi.json` correctly omits it. Advertising a settable `today` invites the exact failure the parser guards against. Surfaced by the O10 conformance test. | Removed `today` from **all** remaining surfaces: the shared `optionsahoy` client + the 4 stable adapters (langchain, crewai, llama-index, arcade) + the ACI `functions.json` spec + 5 READMEs (the 3 P4 adapters were fixed in #143). (`poe.ts` already *deletes* any request `today`, so it was already safe.) While there, the O10 test also caught that those 4 adapters + ACI lacked `protective_put` `ticker` (same gap #142 fixed in the P4 set) - added it everywhere for openapi parity. Extended the conformance test to langchain + crewai; llama-index/arcade are function-based / snake_case so their existing suites cover them (automated conformance would need a case-normalizing harness - noted). All 5 packages bumped 0.1.7 -> 0.1.8 with changelog entries. **Republish to PyPI is a separate `release`/dispatch step** (publish-python.yml fires on release only), to run on Andrew's go. |

## P3 — First-call-success opportunities (high leverage, mostly small)

| ID | Status | Finding | Effort |
|----|--------|---------|--------|
| O1 | DONE (PR #141) | Server `instructions` never mention the `ticker` auto-fill shortcut (biggest first-call lever) | Added the ticker-shortcut sentence to the MCP server `instructions` |
| O2 | DEFERRED | Surface per-tool output schemas + request/response examples into OpenAPI (`result` is bare `{}` today) | Hand-transcribing 7 output schemas into OpenAPI creates exactly the drift the audit flags in O10. **Do it via codegen** (generate the OpenAPI result schemas + examples from the tool descriptors). O10's conformance test now guards the *request* bodies; this remains for *response* schemas. |
| O3 | DONE (PR #141) | Structured error codes instead of free-text on every surface | REST error responses now carry an additive `code` (`invalid_input` for 400, `computation_error` for 500) alongside the human `error` string. Per-field `field` extraction left as a further step. |
| O4 | DONE (this PR) | A `covered_tickers` resource/enum so agents stop guessing and eating round-trips | Exposed **off-resource** to keep the seven-count intact (Andrew's call): added a `coveredTickers()` export to the trailing-returns data and surfaced it as a live `coveredTickers` array on the `GET /mcp` descriptor (not an 8th resource/prompt/tool). The server `instructions` now point agents/tooling at that array to enumerate the auto-fill set without probing. Live from the bundled ETL snapshot, so it tracks each deploy - no hand-maintained list to drift. |
| O5 | DONE (PR #141 + this PR) | Prompts force `volatility`; `terminationDate` required when employed; `cashReturnRate` required | Demoted `volatility` to optional and added a `ticker` arg on all 4 growth prompts (with build + instruction updates); made `amt_iso_optimize.terminationDate` optional (parser already null-safe). **`cashReturnRate` now defaults to 0.04** (Andrew's call - a short-Treasury-like after-tax yield) on the canonical MCP/REST surfaces (parser, tool schema, openapi, toolspec) + the Poe bot's disclosure; a supplied value (incl. 0) still passes through. The 7 SDK adapters + ACI still declare it required (safe - stricter than the endpoint); relaxing them is folded into the pre-publish adapter sweep so 0.1.8 ships consistent. |

## P4 — Reach / adoption

| ID | Status | Finding | Effort / reach |
|----|--------|---------|------|
| O6 | DONE (PR #142) | Ship a JS/TS adapter — biggest untapped audience | Built `integrations/js/optionsahoy-ai-sdk` (Vercel AI SDK, TS, zod schemas, keyless REST, 5 tests). Targets AI SDK v4. Not yet published to npm. |
| O7 | DONE (PR #142) | OpenAI Agents SDK + Pydantic AI wrappers — now-default frameworks | Built `integrations/python/optionsahoy-openai-agents` (8 tests) + `optionsahoy-pydantic-ai` (7 tests), reusing the shared client. Python >=3.10. Not yet published to PyPI or wired into publish-python.yml. |
| O8 | IN PROGRESS (verified 2026-07-06) | Close free listings | **Live:** Official MCP Registry, PulseMCP (cascades), Smithery, Glama, Continue.dev, Gemini CLI gallery, awesome-mcp-servers (merged). **Submitted/pending:** mcp.so, Cline (issues open), Docker catalog (PR #3941, unverified). **Declined by them / dead:** add-mcp (PR #49 rejected - README.md:219 still lists it, stale), Composio, Toolbase, Arcade aggregator. **Prepared, not submitted:** n8n Creator-hub template, a2aregistry, awesome-a2a. **CLA-gated (declined/blocked on a rights grant):** **Zed** - catalog PR zed-industries/extensions#6587 was **closed 2026-07-01**; we withdrew because Zed's CLA (zed.dev/cla) requires a copyright + patent grant AlphaLatitude will not sign. **ACI.dev** - same class: its PR is blocked pending their Contributor License Agreement (`integrations/aci/README.md:88-95`); review ACI's CLA terms before proceeding since we declined Zed's. Remaining go/no-go items for Andrew: n8n template submit, a2aregistry + awesome-a2a (external, per-occasion), ACI CLA decision. |
| O9 | DONE (PR #142) | One orchestration prompt or a "how to combine tools" block | Added a "Combining tools" block to the MCP server `instructions` (count-neutral - avoids an 8th prompt breaking the seven-count invariant). |
| O10 | DONE (this PR) | Codegen or a single `/openapi.json` conformance test to stop 8+ hand-maintained wrapper schemas drifting | Added a per-tool **request-body conformance test** to the 3 audit-active adapters (ai-sdk JS vitest, openai-agents + pydantic-ai pytest): each tool's generated request schema must equal `public/openapi.json`'s property set for that endpoint. It immediately caught 3 real drifts, now fixed: JS missing `haircut` (nso/rsu), Python missing `ticker` (protective_put), and all three advertising the ignored `today` (see D19). Extending the same test to the 4 stable adapters is folded into the D19 follow-up. Response-schema codegen (O2) is separate. |

---

## Notes
- **Web repo** owns a few surfaces (`for-agents`, `use-from-ai-assistants`, `llms.txt`, `openapi.json` mirror) — those were found consistent/complete; the drift is in the MCP-repo docs (`AGENTS.md`, `GEMINI.md`, `README.md`).
- `concentration_analyze`'s put/collar hedge option is intentionally two-structure (no spread there) — not a defect.
- Fixes land as focused PRs per priority band. Update Status + PR # here as each ships.
