"""OptionsAhoy agent tool-use eval.

An inspect_ai evaluation that measures whether an agent reaches the provable
optimum on equity-compensation tax-optimization questions. Two arms: a baseline
arm (the model answers unaided) and a tool arm (the model may call the
OptionsAhoy optimizer). The companion benchmark at
github.com/AlvisoOculus/llm-iso-benchmark shows unaided frontier models overshoot
the achievable optimum by 2x to 20x; this eval turns that finding into a
runnable, reproducible test that any agent builder can point a model at.
"""

from optionsahoy_eval.task import (
    equity_comp_iso,
    equity_comp_iso_baseline,
    equity_comp_iso_tool,
)

__all__ = [
    "equity_comp_iso",
    "equity_comp_iso_baseline",
    "equity_comp_iso_tool",
]
__version__ = "0.1.0"
