# AlphaLatitude Inc. (c) 2026
"""Should I sell or hold my vested RSUs? After-tax comparison in Python.

Compares selling vested restricted stock units (RSUs) at vest against holding them,
on an after-tax, risk-adjusted basis, using the keyless OptionsAhoy REST API. No API
key is required.

Run:
    pip install requests
    python rsu_sell_vs_hold_after_tax.py

API docs: https://optionsahoy.com/for-agents
Verified math: https://optionsahoy.com/verification
"""

import json

import requests

API_URL = "https://optionsahoy.com/api/v1/rsu-sell-vs-hold"  # keyless: no API key


def rsu_sell_vs_hold(
    shares: int = 2000,
    current_price: float = 80.0,
    ordinary_income: float = 250000.0,
    filing_status: str = "single",  # single | married_joint | head_household
    state_code: str = "CA",
    still_employed: bool = True,
    hold_years: float = 1.0,
    ticker: str = "NVDA",  # resolves expected sale price and volatility from a cached table
) -> dict:
    """Return the sell-at-vest versus hold comparison for vested RSUs."""
    payload = {
        "shares": shares,
        "currentPrice": current_price,
        "ordinaryIncome": ordinary_income,
        "filingStatus": filing_status,
        "stateCode": state_code,
        "stillEmployed": still_employed,
        "holdYears": hold_years,
        "ticker": ticker,
    }
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = rsu_sell_vs_hold()
    print("RSU sell-vs-hold result:")
    print(json.dumps(result, indent=2))
