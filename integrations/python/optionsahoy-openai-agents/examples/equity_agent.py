# AlphaLatitude Inc. © 2026
"""Minimal OpenAI Agents SDK agent over the OptionsAhoy calculators.

This attaches the seven OptionsAhoy tools to an ``Agent`` and runs it against an
equity-compensation question. The Agents SDK drives the tool-calling loop; the
tools return exact, tax-aware answers so the model does not estimate the math.

It uses a bring-your-own-key model. By default the Agents SDK uses OpenAI, so set
OPENAI_API_KEY. No OptionsAhoy API key is required.

How to run:

    pip install optionsahoy optionsahoy-openai-agents
    export OPENAI_API_KEY=sk-...
    python equity_agent.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from optionsahoy_openai_agents import get_optionsahoy_tools

QUESTION = (
    "I have 8000 incentive stock options (ISOs) with a $3 strike, current fair "
    "market value $40, granted 2022-03-01, still employed. I file single in "
    "California with $250000 of ordinary income, no alternative minimum tax (AMT) "
    "carryforward credit. I assume a 4% return on cash, a 5-year horizon, and "
    "expect the shares to grow about 12% a year with 50% annual volatility. "
    "How many shares should I exercise each year to stay efficient under the AMT? "
    "Use the optionsahoy_amt_iso_optimize tool."
)


def main() -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        print(
            "No model configured. Set OPENAI_API_KEY (the OpenAI Agents SDK uses "
            "OpenAI by default), then re-run."
        )
        return 0

    from agents import Agent, Runner

    agent = Agent(
        name="Equity assistant",
        instructions=(
            "You are an equity-compensation assistant. Use the OptionsAhoy tools to "
            "compute exact tax-aware answers; do not estimate the math yourself. "
            "After the tool returns, summarize the recommended schedule in plain "
            "language."
        ),
        tools=get_optionsahoy_tools(),
    )

    result = asyncio.run(Runner.run(agent, QUESTION))
    print("Final answer:\n")
    print(result.final_output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
