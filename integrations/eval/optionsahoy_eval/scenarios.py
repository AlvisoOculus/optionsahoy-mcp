"""Scenario data and prompt construction for the OptionsAhoy tool-use eval.

Pure data layer with no inspect_ai dependency, so the ground-truth and scorer
tests can import it without the eval framework installed. ``task.py`` turns the
dicts returned by :func:`get_samples` into inspect Samples.
"""

import json
from pathlib import Path
from typing import Any, Dict, List

_DATA = Path(__file__).with_name("scenarios.json")

_FILING = {
    "single": "single",
    "married_joint": "married filing jointly",
    "head_household": "head of household",
}

_STATE_NAMES = {"CA": "California", "TX": "Texas", "NY": "New York", "NJ": "New Jersey"}

_PROMPT = """As of June 2026.

I have {shares:,} incentive stock options (ISOs) at a ${strike:g} strike price. The current fair market value is ${fmv:g} per share. The stock is publicly traded.

Help me design the best schedule for exercising these ISOs over the next {horizon} years.

My situation:
- Filing {filing}
- Ordinary income: ${ordinaryIncome:,.0f}/year
- {state_line}
- No prior alternative minimum tax (AMT) credit carryforward (zero)
- {cash_line}
- I expect {growth_pct:g}% arithmetic-mean annual return over the {horizon}-year horizon, with {vol_pct:g}% annualized return volatility (sigma = {volatility:g}). Apply standard Ito vol drag to compute the geometric-mean annual return: mu_geometric = mu_arithmetic - sigma^2 / 2. Use mu_geometric to project the year-{horizon} median sale price for all net-final-value calculations.
- ISOs were granted {grant_year}
- Still employed at the company; no plans to leave

I want to maximize my net final value (NFV) at end of year {horizon}.

NFV is defined as cumulative after-tax dollars in hand at end of year {horizon}, treating any cash paid in taxes during years 1 to {horizon_m1} as having a time-value opportunity cost of {cash_pct:g}%/year.

Give the per-year share schedule and your final NFV at end of year {horizon} in U.S. dollars.

End your reply with a line in exactly this format:
ANSWER: $<number>"""


def load_raw() -> Dict[str, Any]:
    """Load the raw scenarios.json contents (meta + scenarios)."""
    return json.loads(_DATA.read_text())


def build_prompt(inputs: Dict[str, Any]) -> str:
    """Render the natural-language question a model sees for one scenario.

    Both arms see the identical prompt; the only difference between arms is
    whether the model is given the OptionsAhoy tool.
    """
    state = _STATE_NAMES.get(inputs["stateCode"], inputs["stateCode"])
    has_state_tax = inputs["stateCode"] not in {"TX", "FL", "WA", "NV", "TN", "SD", "WY", "AK"}
    state_line = (
        f"{state} resident, full year"
        if has_state_tax
        else f"{state} resident, full year (no state income tax)"
    )
    cash_rate = inputs["cashReturnRate"]
    if cash_rate > 0:
        cash_line = (
            f"I have idle cash earning {cash_rate * 100:g}%/year that would cover "
            "any tax I owe at exercise"
        )
    else:
        cash_line = "I would cover any tax owed at exercise from idle cash earning 0%/year"
    return _PROMPT.format(
        shares=inputs["shares"],
        strike=inputs["strike"],
        fmv=inputs["fmv"],
        horizon=inputs["horizon"],
        horizon_m1=inputs["horizon"] - 1,
        filing=_FILING.get(inputs["filingStatus"], inputs["filingStatus"]),
        ordinaryIncome=inputs["ordinaryIncome"],
        state_line=state_line,
        cash_line=cash_line,
        growth_pct=inputs["expectedGrowth"] * 100,
        vol_pct=inputs["volatility"] * 100,
        volatility=inputs["volatility"],
        grant_year=inputs["grantDate"][:4],
        cash_pct=cash_rate * 100,
    )


def get_samples() -> List[Dict[str, Any]]:
    """Return one sample dict per scenario: id, input prose, target NFV, metadata.

    ``target`` is the provable optimum NFV as a string; the scorer compares the
    model's stated NFV to it. ``metadata`` carries the structured inputs and the
    naive lump-sum / even-split baselines for reporting.
    """
    raw = load_raw()
    samples: List[Dict[str, Any]] = []
    for sc in raw["scenarios"]:
        gt = sc["ground_truth"]
        samples.append(
            {
                "id": sc["id"],
                "input": build_prompt(sc["inputs"]),
                "target": f"{gt['optimized_nfv']}",
                "metadata": {
                    "title": sc["title"],
                    "tool": sc["tool"],
                    "inputs": sc["inputs"],
                    "optimum_nfv": gt["optimized_nfv"],
                    "lump_sum_nfv": gt["lump_sum_nfv"],
                    "even_split_nfv": gt["even_split_nfv"],
                },
            }
        )
    return samples
