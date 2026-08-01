# Call the OptionsAhoy MCP server from any model via OpenRouter

[OpenRouter](https://openrouter.ai) gives you one OpenAI-compatible endpoint in
front of hundreds of models. This recipe attaches the public, keyless
**OptionsAhoy Model Context Protocol (MCP)** server to whichever model you route
to, so the model can answer equity-compensation tax questions by calling a
deterministic calculator instead of doing the multi-year math in-context.

## Why a bridge (and not a one-line config)

OpenRouter exposes a generic `/chat/completions` API. It does **not** proxy any
model provider's native or hosted MCP feature (the Anthropic MCP connector, the
OpenAI Responses `type: "mcp"` tool, and so on are provider-specific). So to use
an MCP server through OpenRouter you run a small **client-side bridge**:

1. Open the remote MCP server with the reference `mcp` client.
2. List its tools and pass them to the model as function-calling schemas.
3. Execute any tool calls the model makes, and feed the results back.

That is exactly what [`optionsahoy_openrouter_bridge.py`](optionsahoy_openrouter_bridge.py)
does, in about 100 lines with only `mcp` and `requests`.

## Run it

```bash
pip install -r requirements.txt
export OPENROUTER_API_KEY=sk-or-...          # https://openrouter.ai/keys
python optionsahoy_openrouter_bridge.py
```

Pick any tool-calling model with `OR_MODEL`:

```bash
OR_MODEL="anthropic/claude-3.5-sonnet" python optionsahoy_openrouter_bridge.py
OR_MODEL="google/gemini-2.5-flash"     python optionsahoy_openrouter_bridge.py "Should I sell my RSUs at vest or hold a year?"
```

The OptionsAhoy MCP server (`https://optionsahoy.com/mcp`) needs no key and no
auth. It exposes eight read-only calculators: incentive stock option (ISO) and
alternative minimum tax (AMT) schedule optimization, non-qualified stock option
(NSO) exercise tax, restricted stock unit (RSU) sell-vs-hold, single-stock
concentration, protective puts, collars, and put spreads, Section 1202 qualified small business
stock (QSBS) qualification, funding a cash goal from stock, and the lowest-tax sell
order for vested RSU lots.

## What the contrast looks like

Frontier models overstate the after-tax outcome of the exercise schedule they
propose by roughly 2x to 20x when they compute it directly (benchmark with verbatim transcripts:
[optionsahoy.com/benchmark](https://optionsahoy.com/benchmark)). Attaching the tool
collapses the model's job from "do the tax math" to "call the calculator and relay
the answer."

For the benchmark scenario (20,000 ISOs, $2 strike, $200 fair market value, married
joint, $300,000 ordinary income, California, four-year horizon), a captured run with
`openai/gpt-4o-mini` through OpenRouter:

**Without the MCP**, the model hand-rolls the math and lands on an after-tax net
final value around **$1.25M to $1.88M** across runs.

**With the MCP bridge**, the same model calls `amt_iso_optimize` and relays the
deterministic optimum:

```
[connected: 8 tools on https://optionsahoy.com/mcp]

[tool call -> amt_iso_optimize]
{ "shares": 20000, "strike": 2, "fmv": 200, "expectedGrowth": 0.17,
  "volatility": 0.72, "filingStatus": "married_joint", "ordinaryIncome": 300000,
  "stateCode": "CA", "horizon": 4 }

[final answer]
Year 1: 304 shares | Year 2: 470 | Year 3: 735 | Year 4: 18,491
Projected after-tax net final value: $739,749.82
```

The optimum is independently checkable at
[optionsahoy.com/tools/amt-iso](https://optionsahoy.com/tools/amt-iso); the math is
verified against IRS publications and open-source tax engines at
[optionsahoy.com/verification](https://optionsahoy.com/verification).

## Related

- Keyless Python recipes (REST, no model): [`../recipes`](../recipes)
- Full tool inventory and OpenAPI spec: [optionsahoy.com/for-agents](https://optionsahoy.com/for-agents)
- Per-model benchmark: [optionsahoy.com/benchmark](https://optionsahoy.com/benchmark)
