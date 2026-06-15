# AlphaLatitude Inc. (c) 2026
"""How do I analyze single-stock concentration risk and the after-tax cost of diversifying?

Analyzes a concentrated single-stock position (its share of net worth, risk band, and
long-term capital-gains status) and the after-tax cost of selling down, using the
keyless OptionsAhoy REST API. No API key is required.

Run:
    pip install requests
    python analyze_single_stock_concentration.py

API docs: https://optionsahoy.com/for-agents
Verified math: https://optionsahoy.com/verification
"""

import json

import requests

API_URL = "https://optionsahoy.com/api/v1/concentration"  # keyless: no API key

# Sector options: tech_software, semiconductors, consumer_cyclical, consumer_defensive,
# financials, healthcare_biotech, energy, industrials, communication, broad_market.


def analyze_concentration(
    position_value: float = 800000.0,
    cost_basis: float = 100000.0,
    acquisition_date: str = "2021-03-01",
    sector: str = "tech_software",
    state_code: str = "CA",
    filing_status: str = "single",  # single | married_joint | head_household
    ordinary_income: float = 250000.0,
    total_assets: float = 1200000.0,
    ticker: str = "NVDA",  # resolves expected return and volatility from a cached table
) -> dict:
    """Return the concentration analysis for a single-stock position."""
    payload = {
        "positionValue": position_value,
        "costBasis": cost_basis,
        "acquisitionDate": acquisition_date,
        "sector": sector,
        "stateCode": state_code,
        "filingStatus": filing_status,
        "ordinaryIncome": ordinary_income,
        "totalAssets": total_assets,
        "ticker": ticker,
    }
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = analyze_concentration()
    print(f"Position is {result['concentration'] * 100:.1f}% of net worth "
          f"(risk band: {result['riskBand']})")
    print(f"Long-term capital gains today: {result['isLongTermToday']}; "
          f"days until long-term: {result['daysUntilLongTerm']}")
    print("\nFull result:")
    print(json.dumps(result, indent=2)[:600] + " ...")
