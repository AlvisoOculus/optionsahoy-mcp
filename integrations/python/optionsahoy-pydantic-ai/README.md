# optionsahoy-pydantic-ai

[![PyPI version](https://img.shields.io/pypi/v/optionsahoy-pydantic-ai.svg)](https://pypi.org/project/optionsahoy-pydantic-ai/)
[![Python versions](https://img.shields.io/pypi/pyversions/optionsahoy-pydantic-ai.svg)](https://pypi.org/project/optionsahoy-pydantic-ai/)
[![License: MIT](https://img.shields.io/pypi/l/optionsahoy-pydantic-ai.svg)](https://github.com/AlvisoOculus/optionsahoy-mcp/blob/main/LICENSE)

Pydantic AI tools for the OptionsAhoy equity-compensation calculators. One `pydantic_ai.Tool` per OptionsAhoy REST endpoint, built on the keyless [`optionsahoy`](https://pypi.org/project/optionsahoy/) client. No OptionsAhoy account, no application programming interface (API) key, full federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. See the benchmark, updated for the latest models, at https://optionsahoy.com/benchmark. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## Verified

Beyond determinism, the tax math is independently verified, every release: every 2026 federal constant matches its IRS Rev. Proc. 2025-32 value, worked federal cases reproduce to the cent against the independently-maintained [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state tax reproduces to the cent against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/) across CA, NY, NJ, PA, and MA, with the headline answer recomputed live in your browser. Proof, shown beside the public sources: https://optionsahoy.com/verification

## What it provides

`get_optionsahoy_tools()` returns eight `pydantic_ai.Tool`s, each with a JSON schema mirroring its endpoint:

- `optionsahoy_amt_iso_optimize` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `optionsahoy_nso_calculate` - non-qualified stock option (NSO) exercise tax, sell-at-exercise versus hold
- `optionsahoy_rsu_sell_vs_hold` - restricted stock unit (RSU) sell at vest versus hold for long-term capital gains
- `optionsahoy_concentration_analyze` - single-stock concentration risk and the after-tax cost of diversifying
- `optionsahoy_protective_put_price` - protective put, zero-cost collar, and put spread pricing
- `optionsahoy_qsbs_check` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `optionsahoy_equity_funding_plan` - multi-year plan to fund a cash goal from equity by a target date
- `optionsahoy_rsu_lot_optimize` - which vested RSU lots to sell, and when, to divest a target share fraction at the lowest tax

Each tool returns an independent calculation for one decision. They are not a single joint optimization across your whole equity portfolio; the integrated, cross-asset optimizer is the OptionsAhoy product, currently in invite-only beta.

Coverage spans the full federal tax code plus all 50 states and DC. The adapter pulls in the keyless `optionsahoy` client automatically. No API key is read, stored, or sent anywhere.

## Install

```bash
pip install optionsahoy-pydantic-ai
```

This depends on `pydantic-ai-slim` (the Pydantic AI core); the full `pydantic-ai` distribution installs it too, so either satisfies the requirement.

## Quickstart

Pass the tools to an `Agent`. You bring your own model key (for example `OPENAI_API_KEY`).

```python
from pydantic_ai import Agent

from optionsahoy_pydantic_ai import get_optionsahoy_tools

agent = Agent(
    "openai:gpt-4o-mini",
    system_prompt=(
        "You are an equity-compensation assistant. Use the OptionsAhoy tools to "
        "compute exact tax-aware answers; do not estimate the math yourself."
    ),
    tools=get_optionsahoy_tools(),
)

result = agent.run_sync(
    "I have 8000 ISOs at a $3 strike, current fair market value $40, granted "
    "2022-03-01, still employed. I file single in California with $250000 of "
    "ordinary income, no AMT carryforward, 4% cash return, 5-year horizon, and "
    "expect 12% annual growth at 50% volatility. How many shares should I "
    "exercise each year?"
)
print(result.output)
```

Three ways to attach the tools, pick one:

- `Agent(..., tools=get_optionsahoy_tools())` - pass the tool list at construction.
- `Agent(..., toolsets=[optionsahoy_toolset()])` - pass a ready-made `FunctionToolset`.
- `register_optionsahoy_tools(agent)` - add all eight onto an already-constructed `Agent`.

Pass your own configured client to any of them with `client=OptionsAhoyClient(...)`.

Most of the endpoints accept forward-looking fields (such as `expectedSalePrice` or `volatility`) that the schema marks optional but the API requires at call time; set a covered `ticker` (for example `"NVDA"`) to let the API derive them, or pass explicit values. Omitting both returns a clear 400 explaining which field is needed.

To read the full input schema for any tool, inspect `tools[0].function_schema.json_schema` (substitute the tool you want). The authoritative request schemas are the OpenAPI spec at <https://optionsahoy.com/openapi.json> and the agent docs at <https://optionsahoy.com/for-agents>.

## Runnable example and source

- Runnable example: [`examples/`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/optionsahoy-pydantic-ai/examples)
- Source: [`integrations/python/optionsahoy-pydantic-ai`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/optionsahoy-pydantic-ai)

## Related

Sibling packages wrapping the same calculators:

- [optionsahoy](https://pypi.org/project/optionsahoy/) - plain Python client (no framework)
- [optionsahoy-openai-agents](https://pypi.org/project/optionsahoy-openai-agents/) - OpenAI Agents SDK tools
- [optionsahoy-langchain](https://pypi.org/project/optionsahoy-langchain/) - LangChain tools
- [llama-index-tools-optionsahoy](https://pypi.org/project/llama-index-tools-optionsahoy/) - LlamaIndex tools
- [crewai-optionsahoy](https://pypi.org/project/crewai-optionsahoy/) - CrewAI tools

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
