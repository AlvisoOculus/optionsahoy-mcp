"""Minimal LlamaIndex agent over the OptionsAhoy calculators.

This builds the OptionsAhoy tool list from OptionsAhoyToolSpec, hands it to a LlamaIndex
FunctionAgent with a chat model, and runs the agent to answer an equity-compensation
question. The agent calls the tools for exact, tax-aware numbers rather than estimating
the math itself.

It uses a bring-your-own-key language model. It prefers OpenAI and falls back to
Anthropic, whichever LlamaIndex large language model (LLM) integration is importable and
has a key set in the environment.

How to run (OpenAI):

    pip install optionsahoy llama-index-tools-optionsahoy llama-index-core llama-index-llms-openai
    export OPENAI_API_KEY=sk-...
    python equity_agent.py

How to run (Anthropic instead):

    pip install optionsahoy llama-index-tools-optionsahoy llama-index-core llama-index-llms-anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python equity_agent.py

No OptionsAhoy API key is required.
"""

from __future__ import annotations

import asyncio
import os
import sys

from llama_index.core.agent.workflow import FunctionAgent

from llama_index.tools.optionsahoy import OptionsAhoyToolSpec

QUESTION = (
    "I hold 500 vested restricted stock units (RSUs) currently worth $50 each. I file "
    "single in California with $200000 of ordinary income, am still employed, and would "
    "hold for 1 year. Assume ticker NVDA for forward-looking inputs. Should I sell at "
    "vest or hold? Use the rsu_sell_vs_hold tool and explain which choice leaves more "
    "after-tax wealth."
)


def build_llm():
    """Return a LlamaIndex LLM from whichever provider is configured.

    Returns (None, None) if no supported integration plus key is available, so the
    caller can print guidance and exit cleanly.
    """
    if os.environ.get("OPENAI_API_KEY"):
        try:
            from llama_index.llms.openai import OpenAI
        except ImportError:
            pass
        else:
            return OpenAI(model="gpt-4o-mini"), "OpenAI"

    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            from llama_index.llms.anthropic import Anthropic
        except ImportError:
            pass
        else:
            return Anthropic(model="claude-3-5-haiku-latest"), "Anthropic"

    return None, None


async def run() -> int:
    llm, provider = build_llm()
    if llm is None:
        print(
            "No language model configured. Set OPENAI_API_KEY (and pip install "
            "llama-index-llms-openai), or set ANTHROPIC_API_KEY (and pip install "
            "llama-index-llms-anthropic), then re-run."
        )
        return 0

    print(f"Using {provider} chat model.\n")

    tools = OptionsAhoyToolSpec().to_tool_list()
    agent = FunctionAgent(
        tools=tools,
        llm=llm,
        system_prompt=(
            "You are an equity-compensation assistant. Use the OptionsAhoy tools to "
            "compute exact tax-aware answers; do not estimate the math yourself."
        ),
    )

    response = await agent.run(QUESTION)
    print("Final answer:\n")
    print(response)
    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
