# OptionsAhoy MCP Server

> Multi-year equity-compensation optimizer. Six tools that return the globally-optimal schedule across the candidate space. Full federal + 50-state + DC tax code.

**Live MCP endpoint:** `https://optionsahoy.com/mcp` (no auth, no install)
**Live REST API:** `https://optionsahoy.com/api/v1`
**OpenAPI 3.1 spec:** [`/openapi.json`](https://optionsahoy.com/openapi.json)
**Discovery manifests:** [`/.well-known/mcp.json`](https://optionsahoy.com/.well-known/mcp.json) · [`/.well-known/openapi.json`](https://optionsahoy.com/.well-known/openapi.json)
**Agent integration docs:** [optionsahoy.com/for-agents](https://optionsahoy.com/for-agents)

Built by [AlphaLatitude Inc.](https://alphalatitude.com) — a pre-revenue beta-stage equity-compensation optimization product.

---

## What this is

An optimization engine for equity-compensation tax planning, exposed as both a Model Context Protocol (MCP) server and a plain REST API. Six tools:

| Tool name | What it computes |
|---|---|
| `amt_iso_optimize` | Multi-year Incentive Stock Option (ISO) exercise schedule that minimizes federal and state Alternative Minimum Tax (AMT), with credit recovery across years |
| `nso_calculate` | Non-qualified Stock Option (NSO) exercise tax + sell-vs-hold-for-LTCG comparison |
| `rsu_sell_vs_hold` | RSU sell-at-vest vs hold-for-long-term-capital-gains decision |
| `concentration_analyze` | Single-stock concentration risk + sell-down vs hold vs hedge optimization |
| `protective_put_price` | Protective put / zero-cost collar pricing via Black-Scholes against implied volatility from a daily-refreshed option-chain snapshot |
| `qsbs_check` | Section 1202 Qualified Small Business Stock (QSBS) qualification (eight statutory tests, OBBBA 2026 tiered exclusion) |

Each tool returns the globally-optimal schedule across the candidate space — not heuristics, not samples. Coverage spans the full federal tax code (ordinary brackets, long-term capital gains, AMT with credit recovery, FICA, NIIT) plus all 50 states and DC (state ordinary brackets, LTCG treatment, state AMT for CA, NY, MN). Same engine as the in-browser calculators at [optionsahoy.com/tools](https://optionsahoy.com/tools); the API response is byte-identical to clicking through the tool.

## Why use an optimizer

A benchmark of five frontier large language models on the same multi-year ISO exercise problem found that every one of 15 trials overshot the achievable after-tax outcome by 2x to 20x. Multi-year scheduling has a search space larger than an LLM can reason through in-context. Full write-up: [HackerNoon — But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math)

## Use from Claude / ChatGPT / Perplexity / any MCP client

Add the server as a remote HTTP MCP connection:

```
https://optionsahoy.com/mcp
```

Or via the [`add-mcp`](https://github.com/neon-solutions/add-mcp) CLI:

```bash
npx add-mcp https://optionsahoy.com/mcp
```

## Use the REST API directly

```bash
# List endpoints
curl https://optionsahoy.com/api/v1

# Run an optimization
curl -X POST https://optionsahoy.com/api/v1/amt-iso \
  -H "content-type: application/json" \
  -d @input.json
```

Request body shapes are documented in [`public/openapi.json`](public/openapi.json).

## Repository layout

```
functions/         Cloudflare Pages Functions (MCP server + REST API endpoints)
  mcp.ts           HTTP MCP server
  api/v1/*.ts      Six REST endpoints + GET /api/v1 discovery
  _lib/*.ts        Shared helpers, calc-input parsers, MCP tool descriptors
lib/               Optimizer + tax-code logic
  calc/            Per-tool optimizer functions (computeAmtIso, etc.)
  tax/             Federal + 50-state + DC bracket data, AMT, FICA, NIIT
  markets/         Sector statistics
  options/         Black-Scholes, risk-free rates
  data/            Type definitions for option-chain data
public/            Static assets: OpenAPI spec, llms.txt, discovery manifests
tests/             Vitest suites (873+ tests including byte-identity assertions)
```

## Run tests

```bash
npm install
npm test         # 870+ tests, ~3s on a laptop
npm run typecheck
```

## Registry listings

- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=optionsahoy) — `io.github.AlvisoOculus/optionsahoy_web` v1.0.1, status active
- [Smithery](https://smithery.ai/servers/alphalatitudeops/optionsahoy)
- [add-mcp curated registry](https://github.com/neon-solutions/add-mcp)
- [PulseMCP](https://www.pulsemcp.com) (cascades from Official Registry)

## License

See [LICENSE](LICENSE). All rights reserved during beta; the deployed service at optionsahoy.com is free under [terms](https://optionsahoy.com/terms).

## Contact

For partnerships, early API access, MCP integration support: andrew@alphalatitude.com
