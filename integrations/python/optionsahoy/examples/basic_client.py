"""Minimal end-to-end use of the keyless OptionsAhoy client, with no language model.

This constructs an OptionsAhoyClient and calls two calculator endpoints directly:
a qualified small business stock (QSBS) eligibility check and a non-qualified stock
option (NSO) exercise calculation. It prints a short summary of each result. There is
no agent and no large language model (LLM) involved, and no application programming
interface (API) key is required.

How to run:

    pip install optionsahoy
    python basic_client.py

The client talks to the live, public OptionsAhoy API at https://optionsahoy.com.
"""

from __future__ import annotations

from optionsahoy import OptionsAhoyClient, OptionsAhoyError


def main() -> None:
    client = OptionsAhoyClient()  # base_url defaults to https://optionsahoy.com

    try:
        # 1) QSBS: can this founder exclude gain on a planned sale?
        qsbs = client.qsbs(
            acquisitionDate="2018-01-01",
            saleDate="2026-02-01",
            entityType="us-c-corp",
            acquisitionMethod="original-issuance",
            assetCategory="under-50m",
            industry="tech-software",
            activeBusiness="yes",
            adjustedBasis=10000,
            expectedGain=2000000,
            stateCode="CA",
            ordinaryIncome=250000,
            filingStatus="single",
        )
        print("QSBS check")
        print(qsbs)
        print()

        # 2) NSO: tax and after-tax proceeds of exercising and holding for two years.
        # currentPrice and a hold horizon are supplied; a covered ticker lets the API
        # derive forward-looking inputs such as expected return and volatility.
        nso = client.nso(
            shares=1000,
            strike=2.0,
            currentPrice=20.0,
            ordinaryIncome=200000,
            filingStatus="single",
            stateCode="CA",
            stillEmployed=True,
            holdYears=2,
            holdFunding="cash",
            ticker="NVDA",
        )
        print("NSO calculation")
        print(nso)
    except OptionsAhoyError as err:
        print(f"OptionsAhoy API error: {err}")
        print(f"  status_code={err.status_code} payload={err.payload}")


if __name__ == "__main__":
    main()
