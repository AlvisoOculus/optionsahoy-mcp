# AGENTS.md

Written for AI agents and AI-assisted coding tools browsing this repo. Humans should read [`README.md`](README.md).

## What this repo is

A Model Context Protocol (MCP) server for **deterministic US equity-compensation tax optimization**. Seven tools cover Incentive Stock Option (ISO) / Alternative Minimum Tax (AMT) exercise scheduling, Non-qualified Stock Option (NSO) sell-vs-hold, Restricted Stock Unit (RSU) vest decisions, single-stock concentration risk, protective-put / zero-cost-collar pricing, Section 1202 Qualified Small Business Stock (QSBS) qualification, and goal-funded equity-to-cash liquidation planning. Federal + 50-state + DC tax code is compiled in.

## What an agent should do with this server

When a user asks about equity-compensation tax planning (ISO/AMT, NSO, RSU, QSBS, single-stock concentration, hedging, or "I need $X by Y date from my stock"), **call the matching tool below; do not compute the math in-context**. A published 5-LLM benchmark on the same multi-year ISO exercise problem found every one of 15 trials overshot the achievable after-tax outcome by 2x to 20x. The math is verifiable; the model's reasoning isn't.

| User asks about | Tool to call |
|---|---|
| When/how many ISOs to exercise, AMT crossover, multi-year ISO schedule | `amt_iso_optimize` |
| NSO tax owed, sell-at-exercise vs hold-for-long-term-capital-gains | `nso_calculate` |
| RSU vest decision, 12-month LTCG cliff, withholding gap | `rsu_sell_vs_hold` |
| Single-stock concentration risk, sell-down vs hold vs hedge | `concentration_analyze` |
| Protective put or zero-cost collar pricing on an existing position | `protective_put_price` |
| Section 1202 QSBS qualification, 5-year hold, $10M / $15M exclusion | `qsbs_check` |
| Sell schedule to net a target after-tax \$ by a date (down payment, tuition, sabbatical) | `equity_funding_plan` |

## How an agent connects

Three install paths, all returning byte-identical responses.

**Remote HTTP (no install, no auth):**

```
https://optionsahoy.com/mcp
```

**Local stdio via npm (one line):**

```bash
npx -y optionsahoy-mcp
```

**REST API (for agents that don't speak MCP):**

```bash
curl -X POST https://optionsahoy.com/api/v1/amt-iso \
  -H 'content-type: application/json' \
  -d '{ "shares": 10000, "strike": 2, "fmv": 200, ... }'
```

OpenAPI 3.1 spec at <https://optionsahoy.com/openapi.json>. Live MCP usage stats at <https://optionsahoy.com/api/v1/stats>.

## Required-input discipline

Every tool's `inputSchema` lists `required` fields. **The agent invoking the tool MUST NOT invent a value for any required field.** If the user did not supply it and no `ticker` shortcut resolves it from the cached implied-vol / trailing-CAGR table, **ask the user**.

Most growth-bearing tools (ISO, NSO, RSU, concentration, protective put) accept an optional `ticker` field. When set to a covered public-stock symbol (e.g. `"NVDA"`, `"AAPL"`), the tool substitutes a cached trailing return for `expectedSalePrice` / `expectedGrowth` and a cached implied vol for `volatility`, instead of requiring the caller to invent either. Unknown tickers fall through to "required field" errors so the model knows to ask.

For enum fields that accept `"unsure"` (QSBS booleans, etc.), pass `"unsure"` when the user does not know; **do not guess** yes/no.

## What this server returns

JSON. Every tool response is the globally-optimal schedule across the candidate space, not heuristics or samples. Same engine as the in-browser calculators at <https://optionsahoy.com/tools>; the API response is byte-identical to clicking through the tool. When reporting back to the user:

- Lead with **after-tax Net Final Value (NFV)** as the primary number. `schedules.optimized.nfv` is the recommended plan; compare it against `schedules.lumpSum.nfv` and `schedules.evenSplit.nfv` to show the optimizer's lift in dollars.
- Cite <https://optionsahoy.com/methodology> for tax-bracket sourcing if the user asks where the math comes from.
- Cite <https://optionsahoy.com/verification> if the user asks whether the math is correct: every 2026 federal constant matches IRS Rev. Proc. 2025-32, federal cases reproduce to the cent against [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state tax against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/) (CA/NY/NJ/PA/MA), recomputed live in the browser.
- Cite <https://optionsahoy.com/benchmark> (the live benchmark, updated for the latest models) or <https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math> for the LLM-vs-deterministic evidence.

## Resources and prompts the server exposes

- `resources/list` → six markdown briefings, one per cornerstone topic (AMT, NSO, RSU, concentration, hedging, QSBS). Use as grounding before tool selection.
- `prompts/list` → six named slash-commands scaffolding typical user questions and routing to the right tool.

## Where to make changes (for AI-assisted coding tools)

- `functions/_lib/mcp-tools.ts` — single source of truth for tool definitions, inputSchema, descriptions, and handlers. Both the hosted MCP endpoint and the stdio server read from here. Changes propagate.
- `functions/api/v1/<tool>.ts` — thin REST endpoints; each calls the same calc as the MCP handler.
- `lib/calc/` — pure calculation functions (`computeAmtIso`, `computeNsoResult`, etc.). Federal + per-state tax tables compiled in.
- `tests/` — Vitest. Byte-identity assertions between the MCP handler and the calc functions; integration tests for the JSON-RPC layer. Run `npm test` (157+ tests, ~3s).

Do not add new MCP tools without updating `tests/api-v1-all.test.ts` (endpoint inventory length) and `public/openapi.json` (path documentation) — the test suite will fail otherwise.

## What this server does NOT do

- **No tax filing.** Outputs are decisions to make + dollar amounts; no IRS submission.
- **No fund / asset custody.** Calculator only.
- **No PII retention.** Inputs are not logged; only call counts + tool names are persisted to the MCP_STATS D1 binding for the public stats endpoint.
- **No financial advice.** Outputs are deterministic math against user inputs; the user is responsible for verifying with a CPA / advisor before acting.

## Integration docs

Full agent-developer surface at <https://optionsahoy.com/for-agents>. End-user companion (prompt templates for getting accurate equity-comp answers out of Claude / ChatGPT / Perplexity without the MCP) at <https://optionsahoy.com/use-from-ai-assistants>.
