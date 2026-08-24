# OptionsAhoy MCP Server

[![Glama quality score](https://glama.ai/mcp/servers/AlvisoOculus/optionsahoy-mcp/badges/score.svg)](https://glama.ai/mcp/servers/AlvisoOculus/optionsahoy-mcp)
[![npm version](https://img.shields.io/npm/v/optionsahoy-mcp?logo=npm&label=npm)](https://www.npmjs.com/package/optionsahoy-mcp)
[![MCPSafe security grade](https://api.mcpsafe.io/api/badge/pubfast497de7f7a5466f2a414a)](https://mcpsafe.io/scan/pubfast497de7f7a5466f2a414a)
[![MCP calls in the last 30 days](https://img.shields.io/endpoint?url=https%3A%2F%2Foptionsahoy.com%2Fapi%2Fv1%2Fbadge%3Fmetric%3Dcalls30d&style=flat)](https://optionsahoy.com/for-agents)

<sub>**Independently verified by third parties.** **[Glama](https://glama.ai/mcp/servers/AlvisoOculus/optionsahoy-mcp):** third-party MCP-directory quality score (tool docs, behavior, completeness). · **[npm](https://www.npmjs.com/package/optionsahoy-mcp):** published with build provenance, a signed [SLSA](https://slsa.dev) attestation that this package was built from this repo by GitHub Actions (verify with `npm audit signatures`). · **[MCPSafe](https://mcpsafe.io/scan/pubfast497de7f7a5466f2a414a):** independent 5-model-consensus security scan (AIVSS), Grade A with zero findings.</sub>

<sub>**Validated against trusted sources** (checks we run ourselves, against references we do not control, and that you can reproduce). **[Computation](https://optionsahoy.com/verification):** every 2026 federal tax constant matches its IRS Rev. Proc. 2025-32 / Internal Revenue Code value, and 14 worked federal cases (ordinary income, long-term capital gains, and the Alternative Minimum Tax including the incentive stock option bargain element) reproduce to the cent against the independently-maintained [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), a tax model we did not write. State income tax is cross-checked the same way: 16 cases across California, New York, New Jersey, Pennsylvania, and Massachusetts reproduce to the cent against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/), an independent state tax engine we also did not write. The headline answer is recomputed live in your browser.</sub>

<sub>**Tested and hardened.** **Input safety:** requests are validated against the published schema; bad inputs return a clear 400 with the offending field named, never a crash or a wrong number, and the live API is re-checked by a robustness suite after every deploy. · **Test suite:** the calculation engine is covered by more than a thousand automated tests across the federal and 50-state tax logic, AMT credit recovery, and option pricing; a failing test blocks the release.</sub>

<sub>**Live usage:** MCP calls over the last 30 days, served straight from the server's own telemetry ([/api/v1/stats](https://optionsahoy.com/api/v1/stats), aggregate counts only, no PII).</sub>

Deterministic equity-compensation tax math that any Model Context Protocol (MCP) client can call: incentive stock option (ISO) exercise schedules under the alternative minimum tax (AMT), non-qualified stock option (NSO) and restricted stock unit (RSU) decisions, qualified small business stock (QSBS) qualification, single-stock concentration, protective-put hedging, and equity-funding goals. Relevant federal tax code plus all 50 states and DC, 2026 brackets. Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).

**Why not just ask the model?** We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year ISO exercise problem. Every trial overstated the after-tax result of its own proposed schedule, by 2x to 20x. Multi-year scheduling has a search space larger than is practical to work through in-context; these tools return the verifiable answer instead. Live benchmark, updated for the latest models: [optionsahoy.com/benchmark](https://optionsahoy.com/benchmark). Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math)

## Install in one line

The hosted endpoint is `https://optionsahoy.com/mcp` (HTTP, no auth, no account). Quickest paths:

| Client | Install |
|---|---|
| Any MCP client | Add `https://optionsahoy.com/mcp` as a remote HTTP server, or `npx add-mcp https://optionsahoy.com/mcp` |
| Claude Desktop | Download [`optionsahoy.mcpb`](https://github.com/AlvisoOculus/optionsahoy-mcp/releases/latest/download/optionsahoy.mcpb) and double-click it |
| 19 clients via Smithery | `npx @smithery/cli install alphalatitude/optionsahoy --client claude` |
| Local stdio (npm) | `npx -y optionsahoy-mcp` |

Full install matrix (Gemini CLI extension, config-file JSON, REST API, Google Cloud Agent Registry): [optionsahoy.com/for-agents](https://optionsahoy.com/for-agents).

## The eight tools

| Tool name | What it computes |
|---|---|
| `amt_iso_optimize` | Multi-year ISO exercise schedule that maximizes after-tax net final value at the planning horizon, modeling AMT credit recovery, grant expiration, and the post-termination exercise window |
| `nso_calculate` | After-tax payout on an NSO exercise (federal, state, FICA), comparing sell-at-exercise vs hold for long-term capital gains |
| `rsu_sell_vs_hold` | RSU vest decision: sell at vest vs hold for long-term capital gains, including the gap between 22% supplemental withholding and your marginal bracket |
| `concentration_analyze` | Single-stock concentration risk (drawdown exposure at 30/50/70% downside), comparing after-tax sell-down, hold, and hedge strategies |
| `protective_put_price` | Protective put, zero-cost collar, and put spread pricing via Black-Scholes: annualized hedge cost, maximum loss, upside cap, protected band, floor-hit probability, and which structure it recommends |
| `qsbs_check` | Section 1202 QSBS qualification across the six statutory tests, with the OBBBA 2026 tiered exclusion and per-state conformity |
| `equity_funding_plan` | Multi-year, multi-stack sell schedule to hit a target after-tax amount by a deadline; returns four named plans plus the full risk/wealth frontier |
| `rsu_lot_optimize` | Which vested RSU lots to sell, and on which dates, to divest a target share fraction at the lowest computed tax: specific-lot identification, long-term deferral, and multi-year bracket spreading with in-plan loss carryforward, versus a FIFO sell order |

The ISO optimizer searches its full discretized candidate space and refines share by share, matching a brute-force maximum to the cent on a published tractable case ([see the proof](https://optionsahoy.com/verification)); the planners run deterministic bracket-aware searches and the calculators return exact results. Deterministic computation, not a language-model guess. Coverage spans the relevant federal tax code (ordinary brackets, long-term capital gains, AMT with credit recovery, FICA, NIIT) plus all 50 states and DC (state ordinary brackets, LTCG treatment, state AMT for CA, CO, CT, MN). Same engine as the in-browser calculators at [optionsahoy.com/tools](https://optionsahoy.com/tools); the API response carries the same computed figures as clicking through the tool.

## What a call looks like (all eight tools)

One real call per tool, captured from `https://optionsahoy.com/mcp` and committed under [`docs/examples/`](docs/examples), so every figure below is auditable against the response it came from. The inputs are deliberately explicit (no `ticker`, every date pinned), so re-running [`scripts/capture-readme-examples.mts`](scripts/capture-readme-examples.mts) reproduces the same numbers. Each block shows the ask, the arguments that carry the scenario, and what came back.

### `amt_iso_optimize`

***"I have 50,000 vested ISOs at a $4 strike and the stock is at $90. Married filing jointly, $300,000 of income, California. Should I exercise the whole block now or spread it out?"***

```json
{"shares": 50000, "strike": 4, "fmv": 90, "horizon": 4, "filingStatus": "married_joint",
 "ordinaryIncome": 300000, "stateCode": "CA", "grantDate": "2023-03-15",
 "expectedGrowth": 0.1, "volatilityDrag": 0.2, "cashReturnRate": 0.05, …}
```

The optimized schedule exercises 1,401 / 1,339 / 1,280 / 45,980 shares across the four years and ends at a net final value of $1,623,234, against $1,565,849 for exercising the whole block today. The AMT crossover sits at 699 shares: the first $60,185 of bargain element costs no AMT at all. ([raw](docs/examples/amt_iso_optimize.json); the same position as the site's [published worked example](https://optionsahoy.com/learn/amt-crossover#worked-example), priced with the explicit growth and drag above)

### `nso_calculate`

***"5,000 NSOs at an $8 strike, stock at $75. Do I sell at exercise or hold a year for long-term gains? Single, $250,000 income, California."***

```json
{"shares": 5000, "strike": 8, "currentPrice": 75, "expectedSalePrice": 90, "holdYears": 1,
 "holdFunding": "sell-to-cover", "volatility": 0.3, "ordinaryIncome": 250000,
 "filingStatus": "single", "stateCode": "CA", …}
```

The exercise itself is a $335,000 bargain element taxed $159,618, leaving $175,382 if you sell everything on the spot. Holding a year with a sell-to-cover projects $193,943 against $184,209 for selling now and investing the proceeds, a $9,734 edge for holding. ([raw](docs/examples/nso_calculate.json))

### `rsu_sell_vs_hold`

***"1,000 RSUs vesting at $200. Sell at vest or hold another year and a half? Married filing jointly, $300,000 income, New York."***

```json
{"shares": 1000, "currentPrice": 200, "expectedSalePrice": 220, "holdYears": 1.5,
 "volatility": 0.25, "ordinaryIncome": 300000, "filingStatus": "married_joint",
 "stateCode": "NY", "stillEmployed": true, …}
```

The vest costs $73,896 in total tax, of which $55,716 is federal against only $44,000 withheld at the flat supplemental rate: that gap is the April bill people do not see coming. Selling at vest and investing projects $136,247 at the end of that hold versus $130,817 for holding, so holding loses $5,430 here. ([raw](docs/examples/rsu_sell_vs_hold.json))

### `concentration_analyze`

***"$750,000 of my $2.25M is in one tech stock I bought in 2022 for $150,000. How exposed am I, and what does selling down cost?"***

```json
{"positionValue": 750000, "costBasis": 150000, "acquisitionDate": "2022-01-15",
 "sector": "tech_software", "totalAssets": 2250000, "expectedPositionReturn": 0.12,
 "volatility": 0.35, "ordinaryIncome": 350000, "filingStatus": "single", "stateCode": "CA", …}
```

The position is 33% of net worth, which the tool bands as "Concentrated", and a 50% drawdown in that one name would cost $375,000. Selling it down over three years pays $196,709 in tax against $208,368 for selling in a single year. ([raw](docs/examples/concentration_analyze.json))

### `protective_put_price`

***"I want downside protection on a $500,000 tech position for a year, with a floor about 20% below spot. Put, collar, or put spread?"***

```json
{"positionValue": 500000, "sector": "tech_software", "volatility": 0.35,
 "protectionLevel": 0.2, "tenorYears": 1, "spreadRiskLevel": 0.1, "expectedReturn": 0.08}
```

A bare put struck at $400,000 costs $19,348 a year, 3.87% of the position. The zero-cost collar buys the same floor for a net premium of roughly zero by capping upside at $724,518, which it puts a 15.7% chance on reaching, and that is the structure it recommends. ([raw](docs/examples/protective_put_price.json)) This call passes an explicit sigma, so every leg prices at that one number; pass a `ticker` instead and each leg prices at its own strike's implied volatility off that stock's live option chain, which costs more for a floor this far out of the money.

### `qsbs_check`

***"I bought founder stock in March 2020 and I am selling in March 2026 for a $5M gain. Is it QSBS, and how much is tax-free?"***

```json
{"acquisitionDate": "2020-03-01", "saleDate": "2026-03-15", "entityType": "us-c-corp",
 "acquisitionMethod": "original-issuance", "assetCategory": "under-50m",
 "industry": "tech-software", "adjustedBasis": 50000, "expectedGain": 5000000, …}
```

Verdict `qualifies`: all six statutory tests pass at 6.0 years held, so 100% of the $5,000,000 gain is excludable under the $10,000,000 per-issuer cap, worth $1,190,000 in federal tax. California does not conform, so the same gain is fully taxable by the state. ([raw](docs/examples/qsbs_check.json))

### `equity_funding_plan`

***"I need $400,000 after tax by June 2029 for a house. I hold 3,500 shares at $120 across two lots. What do I sell, and when?"***

```json
{"targetAfterTax": 400000, "targetDate": "2029-06-30", "stacks": [{"currentPrice": 120,
 "expectedAnnualGrowth": 0.08, "lots": [{"shares": 2000, "costBasisPerShare": 50,
 "acquisitionDate": "2022-01-15"}, …]}], "ordinaryIncome": 350000, "stateCode": "CA", …}
```

Selling everything today falls short: it nets $391,574 against the $400,000 goal. The recommended staged plan sells 3,314 of the 3,500 shares over the years to the deadline, lands at $400,075 after tax with $63,740 of tax paid, and beats a single sale in the target year by $12,976. ([raw](docs/examples/equity_funding_plan.json))

### `rsu_lot_optimize`

***"I hold 3,000 vested RSU shares from three vests, the stock is at $180, and I want to cut the position in half over the next two years. Which lots go?"***

```json
{"lots": [{"vestDate": "2022-08-15", "shares": 1200, "costBasisPerShare": 95},
 {"vestDate": "2024-02-15", "shares": 1000, "costBasisPerShare": 130}, …],
 "currentPrice": 180, "divestFraction": 0.5, "horizonYears": 2, "ordinaryIncome": 200000, …}
```

To divest 1,500 of the 3,000 shares it pairs the underwater newest lot against long-term gains from an older one, so the whole divestment costs $2,935 in tax and keeps $267,065 after tax, $29,942 more than selling the same fraction in FIFO order. ([raw](docs/examples/rsu_lot_optimize.json))

Every example above passes volatility and growth explicitly. In a real call you can instead pass `ticker`: volatility resolves from the published implied-vol snapshot as of the last market close, and growth from the cached trailing-CAGR snapshot. If either cannot be resolved the call returns an error naming the exact field rather than a guessed number, and `protective_put_price` echoes `volatilitySource` (`explicit`, `chain`, `ticker`, or `sector-default`) plus `pricingMode` (`chain-skew` or `flat`) so you always know which sigma was priced and whether the legs were priced at their own strikes.

These captures ran in the 2026 tax year. Figures move in a later tax year for the three tools whose schedules run forward from today's date (`amt_iso_optimize`, `equity_funding_plan`, `rsu_lot_optimize`); everything else is pinned by the dates in the arguments.

## Use it in your agent framework (Python)

If you build agents in Python rather than calling the MCP endpoint directly, OptionsAhoy ships installable tool packages for the major agent frameworks. Each one wraps the same calculators behind the framework's native tool interface. All are published on PyPI and all are keyless: no OptionsAhoy account, no API key.

| Framework | Install | Import | Example |
|---|---|---|---|
| LangChain | `pip install optionsahoy-langchain` | `from langchain_optionsahoy import get_optionsahoy_tools` | [`equity_agent.py`](integrations/python/optionsahoy-langchain/examples/equity_agent.py) |
| LlamaIndex | `pip install llama-index-tools-optionsahoy` | `from llama_index.tools.optionsahoy import OptionsAhoyToolSpec` | [`equity_agent.py`](integrations/python/llama-index-tools-optionsahoy/examples/equity_agent.py) |
| CrewAI | `pip install crewai-optionsahoy` | `from crewai_optionsahoy import get_optionsahoy_tools` | [`equity_crew.py`](integrations/python/crewai-optionsahoy/examples/equity_crew.py) |
| Plain Python client | `pip install optionsahoy` | `from optionsahoy import OptionsAhoyClient` | [`basic_client.py`](integrations/python/optionsahoy/examples/basic_client.py) |

The three framework adapters pull in the keyless `optionsahoy` client automatically. There is also an [OpenBB Workspace agent](integrations/openbb-agent) (a FastAPI application built on the OptionsAhoy client) for use inside OpenBB Workspace. Source and runnable examples for all of the above live under [`integrations/python`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python).

## More ways to build

However your agent is built, there is a drop-in piece. All are public and keyless.

| Building block | What it is |
|---|---|
| [Vercel AI SDK tools](integrations/js/optionsahoy-ai-sdk) | A TypeScript package (`optionsahoy-ai-sdk`) exposing all eight calculators as Vercel AI SDK `tool()` definitions, ready to spread into `generateText` / `streamText`. |
| [Instruction kits](integrations/agent-kits) | Editor rules and skills for Cursor, Windsurf, Claude Skills, and Claude Code subagents, so your coding agent calls the OptionsAhoy tools for equity-compensation questions. |
| [Coding recipes](https://github.com/AlvisoOculus/equity-comp-tax-python) | Copy-paste Python recipes, one self-contained file per question, calling the keyless API with only `requests`. Also in [`integrations/recipes`](integrations/recipes). |
| [Builder templates](integrations/agent-builder-templates) | An importable n8n workflow plus build recipes for Flowise, Langflow, and Dify. |
| [Tool-use eval](integrations/eval) | An inspect_ai evaluation measuring whether an agent reaches the provable optimum on a multi-year ISO problem, with and without the tool. |
| [A2A discovery](integrations/openbb-agent) | An Agent2Agent (A2A) Agent Card so other agents can discover and delegate equity-compensation questions to the planner. |
| [Zed extension](integrations/zed) | A Zed editor context-server extension that connects the editor's agent to the OptionsAhoy MCP server. |
| [ACI.dev app](integrations/aci) | The OptionsAhoy app definition for the ACI.dev open-source agent-tool platform. |
| [OpenRouter bridge](integrations/openrouter-bridge) | A recipe for attaching the keyless OptionsAhoy MCP server to any model routed through OpenRouter's OpenAI-compatible endpoint. |

## Try it without installing

The live widget on [optionsahoy.com/for-agents](https://optionsahoy.com/for-agents) calls this same endpoint from your browser. No client, no config.

Prefer a chat interface? The same calculators answer plain-language questions at [poe.com/OptionsAhoy](https://poe.com/OptionsAhoy).

Or watch a real session:

[![Demo: Claude Code installing and using the OptionsAhoy MCP](docs/demo-claude-code-poster.jpg)](https://optionsahoy.com/for-agents#demo)

*Real Claude Code session, unedited. A multi-stack META question (10K ISOs + 6K vested RSUs + 2K fresh RSUs + $400K house in 2027) fires 4 OptionsAhoy MCP tools in parallel: concentration risk, equity funding plan, AMT/ISO optimization, protective put pricing. Claude synthesizes the outputs into one plan that overrides each tool's standalone pick because the user is 86% concentrated in META. 2:13. Click the poster to play it on optionsahoy.com.*

## Endpoints and discovery

**Live MCP endpoint:** `https://optionsahoy.com/mcp`
**Live REST API:** `https://optionsahoy.com/api/v1`
**OpenAPI 3.1 spec:** [`/openapi.json`](https://optionsahoy.com/openapi.json)
**Discovery manifests:** [`/.well-known/mcp.json`](https://optionsahoy.com/.well-known/mcp.json) · [`/.well-known/openapi.json`](https://optionsahoy.com/.well-known/openapi.json)
**Agent integration docs:** [optionsahoy.com/for-agents](https://optionsahoy.com/for-agents)

## MCP resources (topical briefings)

Eight markdown resources under `resources/list` give an LLM enough grounding to discuss the topic before picking a tool. Most map 1:1 with a cornerstone article on [optionsahoy.com/learn](https://optionsahoy.com/learn) and the matching calculator; the equity-funding briefing maps to its calculator, and the covered-tickers briefing enumerates the symbols the optional `ticker` shortcut resolves.

| Resource URI | Topic | Pair with |
|---|---|---|
| `https://optionsahoy.com/learn/amt-crossover` | ISO/AMT crossover and four expensive mistakes | `amt_iso_optimize` |
| `https://optionsahoy.com/learn/nso-sell-vs-hold` | NSO sell-at-exercise vs hold-for-LTCG | `nso_calculate` |
| `https://optionsahoy.com/learn/rsu-withholding-gap` | RSU 22% withholding gap and five April surprises | `rsu_sell_vs_hold` |
| `https://optionsahoy.com/learn/single-stock-concentration-risk` | Concentration risk and diversification trade-off | `concentration_analyze` |
| `https://optionsahoy.com/learn/zero-cost-collars` | Protective puts, zero-cost collars, and put spreads | `protective_put_price` |
| `https://optionsahoy.com/learn/qsbs` | QSBS qualification and five ways to lose the exclusion | `qsbs_check` |
| `https://optionsahoy.com/tools/equity-funding` | Selling equity to fund a cash goal by a deadline | `equity_funding_plan` |
| `https://optionsahoy.com/tools/covered-tickers` | Which symbols the optional `ticker` shortcut resolves | any tool taking `ticker` |

## MCP prompts (workflow scaffolds)

Eight prompts under `prompts/list` scaffold typical user questions and route to the right tool. In Claude Desktop they appear as named slash-commands; in any MCP client, `prompts/get { name, arguments }` returns a fully-templated user message.

| Prompt name | Routes to |
|---|---|
| `optimize-iso-exercise` | `amt_iso_optimize` |
| `analyze-nso-decision` | `nso_calculate` |
| `analyze-rsu-vest` | `rsu_sell_vs_hold` |
| `analyze-concentration` | `concentration_analyze` |
| `price-protective-put` | `protective_put_price` |
| `check-qsbs-eligibility` | `qsbs_check` |
| `plan-equity-funding` | `equity_funding_plan` |
| `plan-equity-portfolio` | several tools, reconciled into one plan |

A `prompts/get` invocation, arguments as strings:

```json
{"name": "optimize-iso-exercise",
 "arguments": {"shares": "50000", "strike": "4", "fmv": "90", "expectedGrowth": "0.1",
               "volatility": "0.5", "state": "CA", "ordinaryIncome": "300000"}}
```

It returns one templated user message ("I have 50000 Incentive Stock Options (ISOs) with a strike of $4 per share ...") that already tells the model to call `amt_iso_optimize` with those values, to ask for any missing required field rather than assume it, and to report the optimized schedule against the lump-sum and even-split alternatives ([raw](docs/examples/prompts_get_optimize-iso-exercise.json)).

## Install details

### Claude Desktop extension (one-click)

The [`optionsahoy.mcpb`](https://github.com/AlvisoOculus/optionsahoy-mcp/releases/latest/download/optionsahoy.mcpb) bundle installs by double-click (or drag onto Claude Desktop → Settings → Extensions), with no terminal or config-file editing, using Claude Desktop's built-in Node.js runtime.

To build the bundle from source:

```bash
npm install && npm run build:mcpb
```

### Smithery CLI (19 clients, one command)

```bash
npx @smithery/cli install alphalatitude/optionsahoy --client claude
```

Swap `claude` for any client Smithery supports: `claude-code`, `cursor`, `vscode`, `gemini-cli`, `codex`, `windsurf`, `cline`, `goose`, `opencode`, and 10 more. Listing: [smithery.ai/servers/alphalatitude/optionsahoy](https://smithery.ai/servers/alphalatitude/optionsahoy).

### Gemini CLI extension

```bash
gemini extensions install https://github.com/AlvisoOculus/optionsahoy-mcp
```

This repo doubles as a [Gemini CLI extension](https://geminicli.com/docs/extensions/): `gemini-extension.json` wires the hosted MCP endpoint and `GEMINI.md` provides usage context to the model.

### Local stdio (npm)

For clients that only support local stdio servers (Claude Desktop without `mcp-remote`, some IDE integrations):

```bash
npx -y optionsahoy-mcp
```

Or add to a Claude Desktop / Cline / Goose config file:

```json
{
  "mcpServers": {
    "optionsahoy": {
      "command": "npx",
      "args": ["-y", "optionsahoy-mcp"]
    }
  }
}
```

The local server returns the same computed figures as the hosted endpoint at `https://optionsahoy.com/mcp`. Source for both lives in [`functions/_lib/mcp-tools.ts`](functions/_lib/mcp-tools.ts); the stdio entry point is [`src/stdio-server.ts`](src/stdio-server.ts).

## Use the REST API directly

```bash
# List endpoints
curl https://optionsahoy.com/api/v1

# Run an optimization (the 50,000-ISO example from "What a call looks like")
curl -X POST https://optionsahoy.com/api/v1/amt-iso \
  -H "content-type: application/json" \
  -d '{"shares":50000,"strike":4,"fmv":90,"horizon":4,"filingStatus":"married_joint",
       "ordinaryIncome":300000,"stateCode":"CA","grantDate":"2023-03-15",
       "hasLeftCompany":false,"expectedGrowth":0.1,"volatilityDrag":0.2,
       "carryforwardCredit":0,"cashReturnRate":0.05}'
```

That returns the same `result.schedules.optimized.nfv` as the MCP call above ([raw](docs/examples/amt_iso_optimize.json)). Request body shapes for the other seven endpoints are documented in [`public/openapi.json`](public/openapi.json).

## Repository layout

```
functions/         Cloudflare Pages Functions (MCP server + REST API endpoints)
  mcp.ts           HTTP MCP server
  api/v1/*.ts      Eight tool endpoints + stats + GET /api/v1 discovery
  _lib/*.ts        Shared helpers, calc-input parsers, MCP tool descriptors
lib/               Optimizer + tax-code logic
  calc/            Per-tool optimizer functions (computeAmtIso, etc.)
  tax/             Federal + 50-state + DC bracket data, AMT, FICA, NIIT
  markets/         Sector statistics
  options/         Black-Scholes, risk-free rates
  data/            Option-chain types, and the readers for the live vol and chain feeds
public/            Static assets: OpenAPI spec, llms.txt, discovery manifests
tests/             Vitest suites (an extensive test suite including byte-identity assertions)
```

## Run tests

```bash
npm install
npm test         # an extensive test suite, ~3s on a laptop
npm run typecheck
```

## Registry listings

- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=optionsahoy) — `io.github.AlvisoOculus/optionsahoy-mcp`, status active
- [Smithery](https://smithery.ai/servers/alphalatitude/optionsahoy) — `alphalatitude/optionsahoy` (plus the [equity-plan skill](https://smithery.ai/skills/alphalatitude/equity-plan))
- [Gemini CLI extensions gallery](https://geminicli.com/extensions/) — `@AlvisoOculus/optionsahoy-mcp`
- [add-mcp curated registry](https://github.com/neon-solutions/add-mcp)
- [PulseMCP](https://www.pulsemcp.com) (cascades from Official Registry)
- [Continue.dev hub](https://hub.continue.dev/andrews-workspace-73/optionsahoy-mcp) — block YAML lives at [`.continue/mcpServers/optionsahoy.yaml`](.continue/mcpServers/optionsahoy.yaml)

## Use from Google Cloud (Gemini agents)

Google Cloud Agent Registry lets each GCP project register external MCP servers for use by Gemini agents. Registration is per-project (no central submission). Two paths:

```bash
# Path A: let the Agent Registry introspect our MCP endpoint
gcloud alpha agent-registry mcp-servers register \
  --uri=https://optionsahoy.com/mcp \
  --display-name="OptionsAhoy" \
  --location=us-central1 \
  --import-tools

# Path B: pass our published toolspec.json directly (faster, no introspection)
gcloud alpha agent-registry mcp-servers register \
  --uri=https://optionsahoy.com/mcp \
  --display-name="OptionsAhoy" \
  --location=us-central1 \
  --tool-spec=<(curl -sSL https://optionsahoy.com/toolspec.json)
```

The toolspec.json mirrors the MCP `tools/list` response with `readOnlyHint` and `idempotentHint` annotations on all eight tools (all are pure deterministic calculators with no side effects). To regenerate after a tool-shape change:

```bash
curl -sS -X POST https://optionsahoy.com/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | jq -c '{tools: [.result.tools[] | . + {annotations: {readOnlyHint:true, idempotentHint:true, destructiveHint:false, openWorldHint:false}}]}' \
  > public/toolspec.json
```

## Troubleshooting

**Connection refused / 404 from the MCP endpoint**
`https://optionsahoy.com/mcp` requires `POST` with `content-type: application/json` and a JSON-RPC body. A `GET` returns a JSON server description; any other verb returns 405. Verify with:
```bash
curl -X POST https://optionsahoy.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}'
```

**Tool calls fail with `Error: ...` text in the response**
The MCP server returns `isError: true` with a human-readable message when input validation fails. Most common: a required field missing, or a number passed as a string. Check the input against the `inputSchema` returned by `tools/list`, or against [`/openapi.json`](https://optionsahoy.com/openapi.json).

**Tool not appearing in Claude.ai or Claude Desktop**
- Confirm the connector URL is exactly `https://optionsahoy.com/mcp` (no trailing slash, no `/v1`).
- In Claude Desktop, restart the app after editing `claude_desktop_config.json`.
- In Claude.ai, the connector toggle is per-chat: enable it in the attachments menu.
- Check the live `tools/list` response (eight tools expected): `curl -X POST https://optionsahoy.com/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'`

**CORS errors from a browser-based client**
The server returns `access-control-allow-origin: *` on all responses including preflight, and accepts the standard MCP headers (`content-type`, `mcp-session-id`, `mcp-protocol-version`). If a browser still blocks, the client is likely sending a non-allowed header — verify the request headers against the `access-control-allow-headers` response.

**Resource / prompt not found**
Resource URIs and prompt names are case-sensitive. Pull the canonical list with `resources/list` and `prompts/list` rather than hand-typing.

**Stale tax-year math**
The tax engine ships with 2026 inflation-adjusted brackets, OBBBA 2026 QSBS rules, and current state-conformity tables. If results look off for a multi-year horizon, verify the input `grantDate`, `acquisitionDate`, or `saleDate` falls in the year you expect — the engine resolves brackets per tax year.

**Reporting a calculation bug or unexpected output**
Email andrew@alphalatitude.com with: the exact JSON-RPC request body, the response, the expected value, and (if known) the IRS publication or state statute the expected value derives from.

## Privacy Policy

Full policy: [optionsahoy.com/privacy](https://optionsahoy.com/privacy).

In short: no account is required and no personally identifiable information is stored — no name, email, IP address, or login. Tool inputs and outputs are retained briefly (about seven days) for debugging and product improvement, alongside aggregate usage metadata (tool, timestamp, coarse location, client type) used to understand usage and detect abuse. The local stdio server and the Claude Desktop extension compute everything on your machine. They make exactly two kinds of network request, both only when you pass a `ticker` without the number it would resolve: the published implied-volatility file, which is one fixed URL carrying no ticker at all, and, for `protective_put_price`, that stock's option chain, whose URL contains the symbol. Nothing else about the call leaves the machine.

## License

MIT. See [LICENSE](LICENSE). The deployed service at https://optionsahoy.com/mcp and https://optionsahoy.com/api/v1 is free during beta under [terms](https://optionsahoy.com/terms).

## Contact

For partnerships, early API access, MCP integration support: andrew@alphalatitude.com
