"""The tool arm reaches the optimum. Marked ``live`` (skipped unless OA_LIVE=1)."""

import asyncio
import os
import re

import pytest

from optionsahoy_eval.scenarios import load_raw
from optionsahoy_eval.tool import amt_iso_optimizer

pytestmark = pytest.mark.skipif(
    os.environ.get("OA_LIVE") != "1",
    reason="live API test; set OA_LIVE=1 to run",
)


@pytest.mark.live
def test_tool_returns_optimum_for_baseline_scenario():
    raw = load_raw()
    sc = next(s for s in raw["scenarios"] if s["id"] == "iso-baseline-ca")
    execute = amt_iso_optimizer()
    out = asyncio.run(execute(**sc["inputs"]))
    assert "Net final value" in out
    nums = [float(n.replace(",", "")) for n in re.findall(r"\$([\d,]+\.\d{2})", out)]
    assert nums, f"no dollar figures in tool output: {out}"
    optimum = sc["ground_truth"]["optimized_nfv"]
    # The optimized NFV is the first dollar figure in the summary string.
    assert abs(nums[0] - optimum) / optimum <= 0.01
