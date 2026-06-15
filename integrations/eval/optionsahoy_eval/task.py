"""inspect_ai tasks: equity-compensation ISO optimization, baseline versus tool arm.

Run the baseline arm (model unaided) and the tool arm (model may call the
OptionsAhoy optimizer) and compare. The baseline arm reproduces the companion
benchmark: unaided frontier models overshoot the achievable optimum. The tool
arm reaches it exactly.
"""

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.solver import generate, system_message, use_tools

from optionsahoy_eval.scenarios import get_samples
from optionsahoy_eval.scorer import optimum_match
from optionsahoy_eval.tool import amt_iso_optimizer

_SYSTEM = (
    "You are an expert equity-compensation tax advisor. The user describes an incentive "
    "stock option (ISO) situation and asks for the exercise schedule that maximizes net "
    "final value (NFV) at the end of the horizon. Account for the alternative minimum tax "
    "(AMT), state income tax, long-term versus short-term capital gains, AMT credit "
    "recovery, and the time value of taxes paid early. Commit to a single recommended "
    "schedule and a single NFV figure. End your reply with a line in exactly this format:\n"
    "ANSWER: $<number>"
)

_SYSTEM_TOOL = _SYSTEM + (
    "\n\nYou have access to the OptionsAhoy optimizer tool. Call it with the user's inputs "
    "and report the optimized net final value it returns."
)


def _dataset() -> list[Sample]:
    return [
        Sample(
            id=s["id"],
            input=s["input"],
            target=s["target"],
            metadata=s["metadata"],
        )
        for s in get_samples()
    ]


@task
def equity_comp_iso(tools: bool = True) -> Task:
    """Equity-compensation ISO optimization eval.

    Args:
        tools: When True (default), the model is given the OptionsAhoy optimizer
            (the tool arm). When False, the model answers unaided (the baseline arm).
    """
    if tools:
        solver = [system_message(_SYSTEM_TOOL), use_tools([amt_iso_optimizer()]), generate()]
    else:
        solver = [system_message(_SYSTEM), generate()]
    return Task(dataset=_dataset(), solver=solver, scorer=optimum_match())


@task
def equity_comp_iso_tool() -> Task:
    """Tool arm: the model may call the OptionsAhoy optimizer."""
    return equity_comp_iso(tools=True)


@task
def equity_comp_iso_baseline() -> Task:
    """Baseline arm: the model answers unaided, with no tools."""
    return equity_comp_iso(tools=False)
