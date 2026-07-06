# AlphaLatitude Inc. (c) 2026
"""How do I price a protective put, a zero-cost collar, or a put spread on a stock position in Python?

Prices three downside hedges on a single-stock position, at a given protection level and
tenor, using the keyless OptionsAhoy REST API. No API key is required. The structures are
the bare protective put, the zero-cost collar, and the put spread (a long put at the floor
financed by a short put at a lower strike). The put spread needs no short call, so it works
on unexercised employee options a collar cannot cover; its protection stops at the short
strike and losses resume below it.

Run:
    pip install requests
    python price_protective_put_or_collar.py

API docs: https://optionsahoy.com/for-agents
Verified math: https://optionsahoy.com/verification
"""

import json

import requests

API_URL = "https://optionsahoy.com/api/v1/protective-put"  # keyless: no API key

# Sector options: tech_software, semiconductors, consumer_cyclical, consumer_defensive,
# financials, healthcare_biotech, energy, industrials, communication, broad_market.


def price_protective_put(
    position_value: float = 500000.0,
    sector: str = "semiconductors",
    protection_level: float = 0.10,  # downside protected, 0.05 to 0.50 (here 10%)
    tenor_years: float = 1.0,
    ticker_label: str = "NVDA",  # resolves implied volatility from a cached table
    spread_risk_level: float = None,  # put-spread short-strike risk: 0.20, 0.10, 0.05, 0.01
) -> dict:
    """Return protective-put, zero-cost-collar, and put-spread pricing for the position."""
    payload = {
        "positionValue": position_value,
        "sector": sector,
        "protectionLevel": protection_level,
        "tenorYears": tenor_years,
        "tickerLabel": ticker_label,
    }
    if spread_risk_level is not None:
        payload["spreadRiskLevel"] = spread_risk_level
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = price_protective_put()
    print("Protective put, collar, and put spread pricing:")
    print(f"  Bare protective put: {json.dumps(result['barePut'])}")
    print(f"  Zero-cost collar:    {json.dumps(result['collar'])}")
    print(f"  Put spread:          {json.dumps(result.get('putSpread'))}")
    print(f"  Recommended:         {result.get('recommended')}")
