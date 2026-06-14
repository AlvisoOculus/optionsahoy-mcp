"""Minimal LangChain tool-calling agent over the OptionsAhoy calculators.

This binds the seven OptionsAhoy tools to a chat model and runs a manual tool-calling
loop (no prebuilt agent runtime, no langgraph) to answer an equity-compensation
question. The loop is: invoke the model, run any requested tools via tool.invoke,
append the results as ToolMessages, then invoke the model again until it produces a
final answer.

It uses a bring-your-own-key chat model. It prefers OpenAI and falls back to Anthropic,
whichever integration is importable and has a key set in the environment.

How to run (OpenAI):

    pip install optionsahoy optionsahoy-langchain langchain-openai
    export OPENAI_API_KEY=sk-...
    python equity_agent.py

How to run (Anthropic instead):

    pip install optionsahoy optionsahoy-langchain langchain-anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    python equity_agent.py

No OptionsAhoy API key is required.
"""

from __future__ import annotations

import os
import sys

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from langchain_optionsahoy import get_optionsahoy_tools

QUESTION = (
    "I have 8000 incentive stock options (ISOs) with a $3 strike, current fair "
    "market value $40, granted 2022-03-01, still employed. I file single in "
    "California with $250000 of ordinary income, no alternative minimum tax (AMT) "
    "carryforward credit, and I assume a 4% return on cash and a 5-year horizon. "
    "How many shares should I exercise each year to stay efficient under the AMT? "
    "Use the optionsahoy_amt_iso_optimize tool."
)


def build_model():
    """Return a tool-calling chat model from whichever provider is configured.

    Returns None if no supported integration plus key is available, so the caller
    can print guidance and exit cleanly.
    """
    if os.environ.get("OPENAI_API_KEY"):
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            pass
        else:
            return ChatOpenAI(model="gpt-4o-mini", temperature=0), "OpenAI"

    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError:
            pass
        else:
            return (
                ChatAnthropic(model="claude-3-5-haiku-latest", temperature=0),
                "Anthropic",
            )

    return None, None


def main() -> int:
    model, provider = build_model()
    if model is None:
        print(
            "No chat model configured. Set OPENAI_API_KEY (and pip install "
            "langchain-openai), or set ANTHROPIC_API_KEY (and pip install "
            "langchain-anthropic), then re-run."
        )
        return 0

    print(f"Using {provider} chat model.\n")

    tools = get_optionsahoy_tools()
    tools_by_name = {t.name: t for t in tools}
    model_with_tools = model.bind_tools(tools)

    messages = [
        SystemMessage(
            content=(
                "You are an equity-compensation assistant. Use the OptionsAhoy tools "
                "to compute exact tax-aware answers; do not estimate the math yourself. "
                "After the tool returns, summarize the recommended schedule in plain "
                "language."
            )
        ),
        HumanMessage(content=QUESTION),
    ]

    # Manual tool-calling loop. A couple of rounds is plenty for one tool call.
    for _ in range(5):
        ai: AIMessage = model_with_tools.invoke(messages)
        messages.append(ai)

        if not ai.tool_calls:
            print("Final answer:\n")
            print(ai.content)
            return 0

        for call in ai.tool_calls:
            tool = tools_by_name[call["name"]]
            print(f"-> calling {call['name']}")
            result = tool.invoke(call["args"])
            messages.append(
                ToolMessage(content=str(result), tool_call_id=call["id"])
            )

    print("Stopped after the maximum number of tool-calling rounds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
