# AlphaLatitude Inc. (c) 2026
"""Which vested RSU lots should I sell, and in which year, to divest a target fraction at the lowest tax?

Chooses which vested restricted stock unit (RSU) lots to sell, and when, to divest a
target share fraction at the lowest tax cost (specific-lot identification, long-term
deferral, and multi-year bracket spreading), and compares that plan against a plain
first-in-first-out (FIFO) sell order, using the keyless OptionsAhoy REST API. No API key
is required.

Run:
    pip install requests
    python optimize_rsu_lot_order.py

API docs: https://optionsahoy.com/for-agents
Verified math: https://optionsahoy.com/verification
"""

# Defer annotation evaluation so the `list | None` hint below parses on
# Python 3.9 (PEP 604 unions are only evaluated eagerly from 3.10 on).
from __future__ import annotations

import json

import requests

API_URL = "https://optionsahoy.com/api/v1/rsu-lot-order"  # keyless: no API key


def optimize_rsu_lot_order(
    current_price: float = 180.0,
    divest_fraction: float = 0.5,  # fraction of shares to divest, 0.1 to 1.0
    horizon_years: int = 2,  # planning horizon in years, 1 to 3
    ordinary_income: float = 200000.0,
    filing_status: str = "single",  # single | married_joint | head_household
    state_code: str = "CA",
    lots: list | None = None,
) -> dict:
    """Return the lowest-tax lot sell order and its delta versus a FIFO sell order.

    Each item in ``lots`` is one vested RSU lot: an ISO vest date, the share count, and
    the cost basis per share (the price recognized as ordinary income at vest).
    """
    if lots is None:
        lots = [
            {"vestDate": "2022-08-15", "shares": 120, "costBasisPerShare": 95},
            {"vestDate": "2024-02-15", "shares": 100, "costBasisPerShare": 130},
            {"vestDate": "2026-05-15", "shares": 80, "costBasisPerShare": 210},
        ]
    payload = {
        "lots": lots,
        "currentPrice": current_price,
        "divestFraction": divest_fraction,
        "horizonYears": horizon_years,
        "ordinaryIncome": ordinary_income,
        "filingStatus": filing_status,
        "stateCode": state_code,
    }
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = optimize_rsu_lot_order()
    print("Recommended RSU lot sell order:")
    print(f"  Headline delta vs FIFO: {result.get('headlineDeltaVsFifo')}")
    print(f"  Total tax:              {result.get('totalTax')}")
    print("  Schedule:")
    print(json.dumps(result["schedule"], indent=2)[:600] + " ...")
