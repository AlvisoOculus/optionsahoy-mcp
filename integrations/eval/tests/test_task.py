"""Task and dataset structure tests. No network, no model."""

from optionsahoy_eval.scenarios import get_samples
from optionsahoy_eval.task import (
    equity_comp_iso,
    equity_comp_iso_baseline,
    equity_comp_iso_tool,
)


def test_dataset_has_all_scenarios():
    samples = get_samples()
    assert len(samples) == 4
    ids = {s["id"] for s in samples}
    assert "iso-baseline-ca" in ids
    for s in samples:
        assert float(s["target"]) > 0
        assert "incentive stock options" in s["input"]
        assert "ANSWER: $<number>" in s["input"]


def test_prompt_includes_all_inputs():
    sample = next(s for s in get_samples() if s["id"] == "iso-baseline-ca")
    prompt = sample["input"]
    assert "20,000 incentive stock options" in prompt
    assert "$2 strike" in prompt
    assert "$200 per share" in prompt
    assert "California resident" in prompt
    assert "sigma = 0.72" in prompt


def test_texas_prompt_flags_no_state_tax():
    sample = next(s for s in get_samples() if s["id"] == "iso-no-state-tax-tx")
    assert "no state income tax" in sample["input"]


def test_zero_cash_prompt():
    sample = next(s for s in get_samples() if s["id"] == "iso-zero-cash-return")
    assert "0%/year" in sample["input"]


def test_baseline_task_has_no_tools():
    t = equity_comp_iso_baseline()
    # baseline solver is [system_message, generate]; tool arm inserts use_tools.
    assert len(t.solver) == 2
    assert len(t.dataset) == 4
    assert t.scorer is not None


def test_tool_task_has_tools():
    t = equity_comp_iso_tool()
    assert len(t.solver) == 3
    assert len(t.dataset) == 4


def test_default_task_is_tool_arm():
    assert len(equity_comp_iso().solver) == 3
    assert len(equity_comp_iso(tools=False).solver) == 2
