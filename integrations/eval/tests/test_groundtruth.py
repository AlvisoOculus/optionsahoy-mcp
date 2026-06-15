"""Drift guard: the cached optimum still matches the live OptionsAhoy API.

Marked ``live`` (skipped unless OA_LIVE=1). When this fails, the live optimizer
has moved beyond drift_tolerance_pct from the committed fixture (usually a tax-table
update). Re-capture scenarios.json and update the values it reports.
"""

import os

import pytest

from optionsahoy import OptionsAhoyClient
from optionsahoy_eval.scenarios import load_raw

pytestmark = pytest.mark.skipif(
    os.environ.get("OA_LIVE") != "1",
    reason="live API test; set OA_LIVE=1 to run",
)


@pytest.mark.live
def test_cached_optima_match_live_api():
    raw = load_raw()
    tol = raw["meta"]["drift_tolerance_pct"] / 100.0
    client = OptionsAhoyClient()
    try:
        for sc in raw["scenarios"]:
            res = client.amt_iso(**sc["inputs"])
            live = res["result"]["schedules"]["optimized"]["nfv"]
            cached = sc["ground_truth"]["optimized_nfv"]
            err = abs(live - cached) / cached
            assert err <= tol, (
                f"{sc['id']}: live optimum ${live:,.2f} drifted {err * 100:.2f}% "
                f"from cached ${cached:,.2f} (tolerance {tol * 100:g}%); re-capture scenarios.json"
            )
    finally:
        client.close()
