# AlphaLatitude Inc. (c) 2026
"""How do I check if my shares qualify for QSBS (Section 1202) capital-gains exclusion?

Checks qualified small business stock (QSBS) eligibility under Internal Revenue Code
Section 1202 and computes the resulting federal and state capital-gains exclusion,
using the keyless OptionsAhoy REST API. No API key is required.

Pass "unsure" for any qualitative field the holder does not know; do not guess.

Run:
    pip install requests
    python check_qsbs_section_1202_eligibility.py

API docs: https://optionsahoy.com/for-agents
Verified math: https://optionsahoy.com/verification
"""

import json

import requests

API_URL = "https://optionsahoy.com/api/v1/qsbs"  # keyless: no API key


def check_qsbs_eligibility(
    acquisition_date: str = "2018-01-01",
    sale_date: str = "2025-06-01",
    entity_type: str = "us-c-corp",  # us-c-corp | other
    acquisition_method: str = "original-issuance",  # original-issuance | gift-or-inheritance | secondary | unsure
    asset_category: str = "under-50m",  # under-50m | 50m-to-75m | over-75m | unsure
    industry: str = "tech-software",  # tech-software, manufacturing, biotech-research, ... | unsure
    active_business: str = "yes",  # yes | no | unsure
    adjusted_basis: float = 50000.0,
    expected_gain: float = 2000000.0,
    state_code: str = "CA",
    ordinary_income: float = 300000.0,
    filing_status: str = "single",  # single | married_joint | head_household
) -> dict:
    """Return the QSBS verdict and the excludable federal and state gain."""
    payload = {
        "acquisitionDate": acquisition_date,
        "saleDate": sale_date,
        "entityType": entity_type,
        "acquisitionMethod": acquisition_method,
        "assetCategory": asset_category,
        "industry": industry,
        "activeBusiness": active_business,
        "adjustedBasis": adjusted_basis,
        "expectedGain": expected_gain,
        "stateCode": state_code,
        "ordinaryIncome": ordinary_income,
        "filingStatus": filing_status,
    }
    response = requests.post(API_URL, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "OptionsAhoy request failed"))
    return data["result"]


if __name__ == "__main__":
    result = check_qsbs_eligibility()
    print(f"QSBS verdict: {result['verdict']}")
    print(f"Exclusion percent: {result['exclusionPercent']}")
    print(f"Excludable gain: {result['excludableGain']}")
    # Present only when the gain exceeds the per-issuer/10x-basis cap: the
    # overage is fully taxable and multi-taxpayer stacking may apply.
    if result.get("cappedOverageNote"):
        print(f"Note: {result['cappedOverageNote']}")
    print("\nFull result:")
    print(json.dumps(result, indent=2)[:600] + " ...")
