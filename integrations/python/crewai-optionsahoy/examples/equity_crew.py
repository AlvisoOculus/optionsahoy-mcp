"""Minimal CrewAI crew that answers an equity-compensation question with OptionsAhoy.

This builds a single CrewAI Agent equipped with the seven OptionsAhoy tools, gives it
one Task, wraps them in a Crew, and runs the crew. The agent uses the tools to compute
exact, tax-aware answers rather than estimating the math itself.

It uses a bring-your-own-key language model. CrewAI reads the model from the standard
provider environment variables. This example expects OPENAI_API_KEY (or ANTHROPIC_API_KEY)
to be set and exits cleanly with guidance if neither is present.

How to run (OpenAI):

    pip install optionsahoy crewai-optionsahoy crewai
    export OPENAI_API_KEY=sk-...
    python equity_crew.py

How to run (Anthropic instead):

    pip install optionsahoy crewai-optionsahoy crewai
    export ANTHROPIC_API_KEY=sk-ant-...
    python equity_crew.py

No OptionsAhoy API key is required.
"""

from __future__ import annotations

import os
import sys

from crewai import Agent, Crew, Process, Task

from crewai_optionsahoy import get_optionsahoy_tools

QUESTION = (
    "A founder acquired original-issuance stock in a US C-corporation on 2018-01-01 "
    "for an adjusted basis of $10000, in the tech-software industry, with the issuer "
    "under $50M in gross assets at issuance and meeting the active-business test. They "
    "plan to sell on 2026-02-01 for an expected gain of $2,000,000. They file single in "
    "California with $250000 of ordinary income. Does this qualify for the qualified "
    "small business stock (QSBS) gain exclusion, and how much gain is excludable? Use "
    "the optionsahoy_qsbs_check tool and report the verdict and excludable gain."
)


def llm_configured() -> bool:
    """True when a provider key CrewAI can use is present in the environment."""
    return bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY"))


def main() -> int:
    if not llm_configured():
        print(
            "No language model configured. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY), "
            "pip install crewai, then re-run."
        )
        return 0

    # Pick a model CrewAI understands from whichever key is set.
    llm = "gpt-4o-mini" if os.environ.get("OPENAI_API_KEY") else "claude-3-5-haiku-latest"

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
        llm=llm,
        verbose=True,
    )

    task = Task(
        description=QUESTION,
        expected_output=(
            "A short answer stating whether the position qualifies for QSBS and the "
            "dollar amount of excludable gain."
        ),
        agent=advisor,
    )

    crew = Crew(agents=[advisor], tasks=[task], process=Process.sequential, verbose=True)

    result = crew.kickoff()
    print("\nFinal answer:\n")
    print(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
