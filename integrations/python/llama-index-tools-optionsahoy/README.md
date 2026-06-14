# llama-index-tools-optionsahoy

LlamaIndex tools for the OptionsAhoy equity-compensation calculators. `OptionsAhoyToolSpec` exposes one tool per OptionsAhoy REST endpoint, built on the keyless [`optionsahoy`](https://pypi.org/project/optionsahoy/) client. No OptionsAhoy account, no application programming interface (API) key, full federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## What it provides

`OptionsAhoyToolSpec().to_tool_list()` returns seven LlamaIndex `FunctionTool`s, one per endpoint:

- `amt_iso_optimize` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `nso_calculate` - non-qualified stock option (NSO) exercise tax, sell-at-exercise versus hold
- `rsu_sell_vs_hold` - restricted stock unit (RSU) sell at vest versus hold for long-term capital gains
- `concentration_analyze` - single-stock concentration risk and the after-tax cost of diversifying
- `protective_put_price` - protective put and zero-cost collar pricing
- `qsbs_check` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `equity_funding_plan` - multi-year plan to fund a cash goal from equity by a target date

Coverage spans the full federal tax code plus all 50 states and DC. The adapter pulls in the keyless `optionsahoy` client automatically. No API key is read, stored, or sent anywhere.

## Install

```bash
pip install llama-index-tools-optionsahoy
```

## Quickstart

Hand the tools to a LlamaIndex agent backed by any chat model:

```python
import asyncio

from llama_index.core.agent.workflow import FunctionAgent
from llama_index.llms.openai import OpenAI  # pip install llama-index-llms-openai; set OPENAI_API_KEY

from llama_index.tools.optionsahoy import OptionsAhoyToolSpec

tools = OptionsAhoyToolSpec().to_tool_list()

agent = FunctionAgent(
    tools=tools,
    llm=OpenAI(model="gpt-4o-mini"),
    system_prompt=(
        "You are an equity-compensation assistant. Use the OptionsAhoy tools to "
        "compute exact tax-aware answers; do not estimate the math yourself."
    ),
)

QUESTION = (
    "I hold 500 vested RSUs currently worth $50 each. I file single in California "
    "with $200000 of ordinary income, am still employed, and would hold for 1 year. "
    "Assume ticker NVDA for forward-looking inputs. Should I sell at vest or hold? "
    "Use the rsu_sell_vs_hold tool."
)

async def main():
    response = await agent.run(QUESTION)
    print(response)

asyncio.run(main())
```

Pass your own configured client with `OptionsAhoyToolSpec(client=OptionsAhoyClient(...))`.

The seven endpoints accept forward-looking fields (such as `expectedSalePrice` or `volatility`) that the schema marks optional but the API requires at call time; set a covered `ticker` (for example `"NVDA"`) to let the API derive them, or pass explicit values. Omitting both returns a clear 400 explaining which field is needed.

## Runnable example and source

- Runnable example: [`examples/`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/llama-index-tools-optionsahoy/examples)
- Source: [`integrations/python/llama-index-tools-optionsahoy`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/llama-index-tools-optionsahoy)

## Related

Sibling packages wrapping the same calculators:

- [optionsahoy](https://pypi.org/project/optionsahoy/) - plain Python client (no framework)
- [optionsahoy-langchain](https://pypi.org/project/optionsahoy-langchain/) - LangChain tools
- [crewai-optionsahoy](https://pypi.org/project/crewai-optionsahoy/) - CrewAI tools

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
