# crewai-optionsahoy

CrewAI tools for the OptionsAhoy equity-compensation calculators. One `crewai.tools.BaseTool` per OptionsAhoy REST endpoint, built on the keyless [`optionsahoy`](https://pypi.org/project/optionsahoy/) client. No OptionsAhoy account, no application programming interface (API) key, full federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## What it provides

`get_optionsahoy_tools()` returns seven CrewAI `BaseTool`s, each with a pydantic `args_schema` mirroring its endpoint:

- `optionsahoy_amt_iso_optimize` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `optionsahoy_nso_calculate` - non-qualified stock option (NSO) exercise tax, sell-at-exercise versus hold
- `optionsahoy_rsu_sell_vs_hold` - restricted stock unit (RSU) sell at vest versus hold for long-term capital gains
- `optionsahoy_concentration_analyze` - single-stock concentration risk and the after-tax cost of diversifying
- `optionsahoy_protective_put_price` - protective put and zero-cost collar pricing
- `optionsahoy_qsbs_check` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `optionsahoy_equity_funding_plan` - multi-year plan to fund a cash goal from equity by a target date

Coverage spans the full federal tax code plus all 50 states and DC. The adapter pulls in the keyless `optionsahoy` client automatically. No API key is read, stored, or sent anywhere.

## Install

```bash
pip install crewai-optionsahoy
```

## Quickstart

Equip a CrewAI agent with the tools and run a crew. CrewAI reads the model from the standard provider environment variables (for example `OPENAI_API_KEY`):

```python
from crewai import Agent, Crew, Process, Task

from crewai_optionsahoy import get_optionsahoy_tools

tools = get_optionsahoy_tools()

advisor = Agent(
    role="Equity-compensation analyst",
    goal="Answer equity-compensation tax questions using the OptionsAhoy tools.",
    backstory=(
        "You analyze stock-option and equity tax questions for technology workers. "
        "You always call the OptionsAhoy tools for exact numbers instead of "
        "estimating the tax math yourself."
    ),
    tools=tools,
    llm="gpt-4o-mini",
    verbose=True,
)

task = Task(
    description=(
        "A founder acquired original-issuance stock in a US C-corporation on "
        "2018-01-01 for an adjusted basis of $10000, in the tech-software industry, "
        "issuer under $50M in gross assets at issuance and meeting the active-business "
        "test. They plan to sell on 2026-02-01 for an expected gain of $2,000,000. "
        "They file single in California with $250000 of ordinary income. Does this "
        "qualify for QSBS, and how much gain is excludable? "
        "Use the optionsahoy_qsbs_check tool."
    ),
    expected_output="Whether the position qualifies and the dollar amount of excludable gain.",
    agent=advisor,
)

crew = Crew(agents=[advisor], tasks=[task], process=Process.sequential, verbose=True)
print(crew.kickoff())
```

Pass your own configured client with `get_optionsahoy_tools(client=OptionsAhoyClient(...))`.

The seven endpoints accept forward-looking fields (such as `expectedSalePrice` or `volatility`) that the schema marks optional but the API requires at call time; set a covered `ticker` (for example `"NVDA"`) to let the API derive them, or pass explicit values. Omitting both returns a clear 400 explaining which field is needed.

## Runnable example and source

- Runnable example: [`examples/`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/crewai-optionsahoy/examples)
- Source: [`integrations/python/crewai-optionsahoy`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/crewai-optionsahoy)

## Related

Sibling packages wrapping the same calculators:

- [optionsahoy](https://pypi.org/project/optionsahoy/) - plain Python client (no framework)
- [optionsahoy-langchain](https://pypi.org/project/optionsahoy-langchain/) - LangChain tools
- [llama-index-tools-optionsahoy](https://pypi.org/project/llama-index-tools-optionsahoy/) - LlamaIndex tools

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
