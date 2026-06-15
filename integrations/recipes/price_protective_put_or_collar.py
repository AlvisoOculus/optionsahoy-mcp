# AlphaLatitude Inc. (c) 2026
"""How do I price a protective put or a zero-cost collar on a stock position in Python?

Prices a protective put hedge and a zero-cost collar on a single-stock position, at a
given downside protection level and tenor, using the keyless OptionsAhoy REST API. No
API key is required.

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
) -> dict:
    """Return protective-put and zero-cost-collar pricing for the position."""
    payload = {
        "positionValue": position_value,
        "sector": sector,
        "protectionLevel": protection_level,
        "tenorYears": tenor_years,
        "tickerLabel": ticker_label,
    }
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = price_protective_put()
    print("Protective put and collar pricing:")
    print(f"  Bare protective put: {json.dumps(result['barePut'])}")
    print(f"  Zero-cost collar:    {json.dumps(result['collar'])}")
