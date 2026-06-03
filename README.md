# OptionsAhoy MCP Server

> Equity-compensation optimizer. ISO/AMT, NSO, RSU, QSBS, single-stock concentration, protective puts/collars, and equity-funding plans. Seven deterministic tools across the federal + 50-state + DC tax code.

**Live MCP endpoint:** `https://optionsahoy.com/mcp` (no auth, no install)
**Live REST API:** `https://optionsahoy.com/api/v1`
**OpenAPI 3.1 spec:** [`/openapi.json`](https://optionsahoy.com/openapi.json)
**Discovery manifests:** [`/.well-known/mcp.json`](https://optionsahoy.com/.well-known/mcp.json) · [`/.well-known/openapi.json`](https://optionsahoy.com/.well-known/openapi.json)
**Agent integration docs:** [optionsahoy.com/for-agents](https://optionsahoy.com/for-agents)

Built by [AlphaLatitude Inc.](https://alphalatitude.com) — a pre-revenue beta-stage equity-compensation optimization product.

---

## What this is

An optimization engine for equity-compensation tax planning, exposed as both a Model Context Protocol (MCP) server and a plain REST API. Seven tools:

| Tool name | What it computes |
|---|---|
| `amt_iso_optimize` | Multi-year Incentive Stock Option (ISO) exercise schedule that minimizes federal and state Alternative Minimum Tax (AMT), with credit recovery across years |
| `nso_calculate` | Non-qualified Stock Option (NSO) exercise tax + sell-vs-hold-for-LTCG comparison |
| `rsu_sell_vs_hold` | RSU sell-at-vest vs hold-for-long-term-capital-gains decision |
| `concentration_analyze` | Single-stock concentration risk + sell-down vs hold vs hedge optimization |
| `protective_put_price` | Protective put / zero-cost collar pricing via Black-Scholes against implied volatility from a daily-refreshed option-chain snapshot |
| `qsbs_check` | Section 1202 Qualified Small Business Stock (QSBS) qualification (eight statutory tests, OBBBA 2026 tiered exclusion) |
| `equity_funding_plan` | Multi-year, multi-stack equity-funding plan for hitting a target after-tax amount by a deadline. Returns four named plans (Lock-in-now / Balanced / Hold-for-growth / Recommended) plus the full risk/wealth frontier. |

Each tool returns the globally-optimal schedule across the candidate space — not heuristics, not samples. Coverage spans the full federal tax code (ordinary brackets, long-term capital gains, AMT with credit recovery, FICA, NIIT) plus all 50 states and DC (state ordinary brackets, LTCG treatment, state AMT for CA, NY, MN). Same engine as the in-browser calculators at [optionsahoy.com/tools](https://optionsahoy.com/tools); the API response is byte-identical to clicking through the tool.

### MCP resources (topical briefings)

Six markdown resources under `resources/list` give an LLM enough grounding to discuss the topic before picking a tool. Each maps 1:1 with a cornerstone article on [optionsahoy.com/learn](https://optionsahoy.com/learn) and the matching calculator.

| Resource URI | Topic | Pair with |
|---|---|---|
| `https://optionsahoy.com/learn/amt-crossover` | ISO/AMT crossover and four expensive mistakes | `amt_iso_optimize` |
| `https://optionsahoy.com/learn/nso-sell-vs-hold` | NSO sell-at-exercise vs hold-for-LTCG | `nso_calculate` |
| `https://optionsahoy.com/learn/rsu-withholding-gap` | RSU 22% withholding gap and five April surprises | `rsu_sell_vs_hold` |
| `https://optionsahoy.com/learn/single-stock-concentration-risk` | Concentration risk and diversification trade-off | `concentration_analyze` |
| `https://optionsahoy.com/learn/zero-cost-collars` | Protective puts and zero-cost collars | `protective_put_price` |
| `https://optionsahoy.com/learn/qsbs` | QSBS qualification and five ways to lose the exclusion | `qsbs_check` |

### MCP prompts (workflow scaffolds)

Six prompts under `prompts/list` scaffold typical user questions and route to the right tool. In Claude Desktop they appear as named slash-commands; in any MCP client, `prompts/get { name, arguments }` returns a fully-templated user message.

| Prompt name | Routes to |
|---|---|
| `optimize-iso-exercise` | `amt_iso_optimize` |
| `analyze-nso-decision` | `nso_calculate` |
| `analyze-rsu-vest` | `rsu_sell_vs_hold` |
| `analyze-concentration` | `concentration_analyze` |
| `price-protective-put` | `protective_put_price` |
| `check-qsbs-eligibility` | `qsbs_check` |

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

- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=optionsahoy) — `io.github.AlvisoOculus/optionsahoy-mcp` v1.0.0, status active
- [Smithery](https://smithery.ai/server/@alphalatitudeops/optionsahoy)
- [add-mcp curated registry](https://github.com/neon-solutions/add-mcp)
- [PulseMCP](https://www.pulsemcp.com) (cascades from Official Registry)

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

The toolspec.json mirrors the MCP `tools/list` response with `readOnlyHint` and `idempotentHint` annotations on all six tools (all are pure deterministic calculators with no side effects). To regenerate after a tool-shape change:

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
- Check the live `tools/list` response (six tools expected): `curl -X POST https://optionsahoy.com/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'`

**CORS errors from a browser-based client**
The server returns `access-control-allow-origin: *` on all responses including preflight, and accepts the standard MCP headers (`content-type`, `mcp-session-id`, `mcp-protocol-version`). If a browser still blocks, the client is likely sending a non-allowed header — verify the request headers against the `access-control-allow-headers` response.

**Resource / prompt not found**
Resource URIs and prompt names are case-sensitive. Pull the canonical list with `resources/list` and `prompts/list` rather than hand-typing.

**Stale tax-year math**
The tax engine ships with 2026 inflation-adjusted brackets, OBBBA 2026 QSBS rules, and current state-conformity tables. If results look off for a multi-year horizon, verify the input `grantDate`, `acquisitionDate`, or `saleDate` falls in the year you expect — the engine resolves brackets per tax year.

**Reporting a calculation bug or unexpected output**
Email andrew@alphalatitude.com with: the exact JSON-RPC request body, the response, the expected value, and (if known) the IRS publication or state statute the expected value derives from.

## License

MIT. See [LICENSE](LICENSE). The deployed service at https://optionsahoy.com/mcp and https://optionsahoy.com/api/v1 is free during beta under [terms](https://optionsahoy.com/terms).

## Contact

For partnerships, early API access, MCP integration support: andrew@alphalatitude.com

## Deployment topology

Two pieces serve the live endpoint:

1. **Cloudflare Pages project** (GitHub-connected to this repo) auto-deploys
   `functions/` + `public/` on every push to main → `optionsahoy-mcp.pages.dev`.
2. **Cloudflare Worker** in [`worker-proxy/`](worker-proxy/) forwards
   `optionsahoy.com/mcp*` + `/api/v1/*` to that Pages deployment, so the
   public URL stays stable. One-time `wrangler deploy` — see
   [`worker-proxy/README.md`](worker-proxy/README.md).

## Call stats (D1)

Every inbound MCP and REST call writes one row to a D1 table via
`ctx.waitUntil` (fire-and-forget — never blocks the response). View
aggregates at `https://optionsahoy-mcp.pages.dev/admin/mcp-stats?token=<ADMIN_TOKEN>`.

**One-time setup (Andrew):**

```bash
# 1. Create the database. Outputs a database_id.
cd /Users/andrewk/Projects/optionsahoy-mcp
npx wrangler d1 create optionsahoy-mcp-stats

# 2. Apply the schema.
npx wrangler d1 execute optionsahoy-mcp-stats --remote \
  --file=db/migrations/0001_init.sql

# 3. Generate a token.
openssl rand -hex 32
```

Then in the Cloudflare dashboard for the `optionsahoy-mcp` Pages project:

- **Settings → Functions → D1 database bindings** — add variable name
  `MCP_STATS`, point at the database created in step 1.
- **Settings → Environment variables → Production** — add `ADMIN_TOKEN`
  with the value from step 3 (mark as encrypted).

After the next deploy, `/admin/mcp-stats?token=...&days=30` renders the
dashboard. Without the bindings, `logCall` silently no-ops and the admin
page returns 503 (the rest of the server is unaffected).

What's logged: `ts, endpoint, tool, is_error, error_msg (truncated 500),
client_name, ua (truncated 200), country`. Tool arguments are **never**
logged (PII + table-size).
