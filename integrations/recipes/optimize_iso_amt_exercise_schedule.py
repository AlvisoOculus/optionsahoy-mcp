# AlphaLatitude Inc. (c) 2026
"""How do I calculate the optimal multi-year ISO exercise schedule under the AMT in Python?

Computes the incentive stock option (ISO) exercise schedule that maximizes after-tax
net final value (NFV) under the alternative minimum tax (AMT), across a multi-year
horizon, using the keyless OptionsAhoy REST API. No API key is required.

Run:
    pip install requests
    python optimize_iso_amt_exercise_schedule.py

API docs: https://optionsahoy.com/for-agents
The math is deterministic and independently verified: https://optionsahoy.com/verification
"""

import json

import requests

API_URL = "https://optionsahoy.com/api/v1/amt-iso"  # keyless: no API key


def optimize_iso_exercise_schedule(
    shares: int = 20000,
    strike: float = 2.0,
    fmv: float = 200.0,
    filing_status: str = "married_joint",  # single | married_joint | head_household
    ordinary_income: float = 300000.0,
    state_code: str = "CA",
    horizon_years: int = 4,
    expected_growth: float = 0.17,  # expected arithmetic-mean annual return
    volatility: float = 0.72,  # annualized return volatility (sigma)
    cash_return_rate: float = 0.055,
    grant_date: str = "2022-01-01",
) -> dict:
    """Return the optimized ISO exercise schedule and its net final value (NFV).

    The result includes ``schedules.optimized`` (the recommended plan and its ``nfv``)
    alongside ``schedules.lumpSum`` and ``schedules.evenSplit`` baselines for comparison.
    """
    payload = {
        "shares": shares,
        "strike": strike,
        "fmv": fmv,
        "filingStatus": filing_status,
        "ordinaryIncome": ordinary_income,
        "stateCode": state_code,
        "carryforwardCredit": 0,
        "horizon": horizon_years,
        "cashReturnRate": cash_return_rate,
        "grantDate": grant_date,
        "hasLeftCompany": False,
        "terminationDate": None,
        "expectedGrowth": expected_growth,
        "volatility": volatility,
    }
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = optimize_iso_exercise_schedule()
    schedules = result["schedules"]
    optimized = schedules["optimized"]
    schedule = [year["shares"] for year in optimized["years"]]
    print(f"Optimized exercise schedule (shares per year): {schedule}")
    print(f"Optimized after-tax net final value: ${optimized['nfv']:,.2f}")
    print(f"Lump-sum baseline:                  ${schedules['lumpSum']['nfv']:,.2f}")
    print(f"Even-split baseline:                ${schedules['evenSplit']['nfv']:,.2f}")
    print("\nFull result:")
    print(json.dumps(result, indent=2)[:600] + " ...")
