# AlphaLatitude Inc. (c) 2026
"""How do I plan which stock to sell, and when, to net a cash goal after tax (e.g. a down payment)?

Plans which equity lots to sell, and in which year, to fund a target after-tax cash
amount by a date with the least tax cost, using the keyless OptionsAhoy REST API. No
API key is required.

Run:
    pip install requests
    python plan_stock_sales_for_cash_goal.py

API docs: https://optionsahoy.com/for-agents
Verified math: https://optionsahoy.com/verification
"""

# Defer annotation evaluation so the `list | None` hint below parses on
# Python 3.9 (PEP 604 unions are only evaluated eagerly from 3.10 on).
from __future__ import annotations

import json

import requests

API_URL = "https://optionsahoy.com/api/v1/equity-funding"  # keyless: no API key


def plan_equity_sales_for_cash_goal(
    target_after_tax: float = 200000.0,
    target_date: str = "2027-06-01",
    ordinary_income: float = 250000.0,
    filing_status: str = "single",  # single | married_joint | head_household
    state_code: str = "CA",
    stacks: list | None = None,
) -> dict:
    """Return the sell schedule that funds the cash goal at the least after-tax cost.

    Each item in ``stacks`` is one equity position: a ticker, the current price, and a
    list of lots (each with shares, cost basis per share, and an acquisition date).
    """
    if stacks is None:
        stacks = [
            {
                "ticker": "NVDA",
                "currentPrice": 80.0,
                "lots": [
                    {"shares": 5000, "costBasisPerShare": 10.0, "acquisitionDate": "2022-01-01"}
                ],
            }
        ]
    payload = {
        "targetAfterTax": target_after_tax,
        "targetDate": target_date,
        "ordinaryIncome": ordinary_income,
        "filingStatus": filing_status,
        "stateCode": state_code,
        "stacks": stacks,
    }
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = plan_equity_sales_for_cash_goal()
    print("Recommended funding plan:")
    print(json.dumps(result["recommended"], indent=2)[:600] + " ...")
