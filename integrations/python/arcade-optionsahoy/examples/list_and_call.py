# AlphaLatitude Inc. © 2026
"""Load the OptionsAhoy Arcade toolkit, list its tools, and call one against the live API.

This builds an Arcade ToolCatalog from the installed `arcade_optionsahoy` package, prints the
seven registered tool names, then calls the QSBS check directly as a plain Python function and
prints the verdict and excludable gain. No OptionsAhoy API key is required; the call hits the
public https://optionsahoy.com API.

How to run:

    pip install optionsahoy arcade-optionsahoy arcade-tdk
    python list_and_call.py
"""

from __future__ import annotations

import sys

import arcade_optionsahoy
from arcade_tdk import ToolCatalog


def main() -> int:
    catalog = ToolCatalog()
    catalog.add_module(arcade_optionsahoy)

    print(f"Registered {len(catalog)} OptionsAhoy tools:")
    for tool in catalog:
        print(f"  - {tool.definition.name}")

    print("\nCalling QsbsCheck against the live API...\n")
    result = arcade_optionsahoy.qsbs_check(
        acquisition_date="2018-01-01",
        sale_date="2026-02-01",
        entity_type="us-c-corp",
        acquisition_method="original-issuance",
        asset_category="under-50m",
        industry="tech-software",
        active_business="yes",
        adjusted_basis=10000,
        expected_gain=2000000,
        state_code="CA",
        ordinary_income=250000,
        filing_status="single",
    )
    body = result.get("result", result)
    print(f"verdict:        {body.get('verdict')}")
    print(f"excludableGain: {body.get('excludableGain')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
