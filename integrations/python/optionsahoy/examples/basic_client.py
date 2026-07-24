"""End-to-end use of the keyless OptionsAhoy client, with no language model.

This constructs an OptionsAhoyClient and calls every one of the eight calculator
endpoints directly, printing a short summary of each result. There is no agent and no
large language model (LLM) involved, and no application programming interface (API) key
is required.

The eight calculators:

1. amt_iso          - incentive stock option (ISO) exercise schedule under the
                      alternative minimum tax (AMT)
2. nso              - non-qualified stock option (NSO) exercise, hold versus sell
3. rsu_sell_vs_hold - restricted stock unit (RSU) at vest, hold versus sell
4. concentration    - single-stock concentration risk and the cost of diversifying
5. protective_put   - protective put, zero-cost collar, and put spread pricing
6. qsbs             - qualified small business stock (QSBS) Section 1202 eligibility
7. equity_funding   - plan which lots to sell, and when, to fund a cash goal
8. rsu_lot_order    - lowest-tax sell order for vested RSU lots, versus FIFO

Several calculators need a forward-looking input (expected growth, sale price, or
volatility). You can pass those values explicitly, or pass a covered ``ticker`` and let
the API derive them from that symbol. This file shows both styles: explicit values for
the private-company ISO case, and a ticker for the public-stock cases.

How to run:

    pip install optionsahoy
    python basic_client.py

The client talks to the live, public OptionsAhoy API at https://optionsahoy.com.
"""

from __future__ import annotations

from optionsahoy import OptionsAhoyClient, OptionsAhoyError


def usd(value: float) -> str:
    """Format a number as whole US dollars."""
    return f"${value:,.0f}"


def main() -> None:
    client = OptionsAhoyClient()  # base_url defaults to https://optionsahoy.com

    try:
        # 1) ISO/AMT: how many shares to exercise each year for the best after-tax
        # outcome. This is a private company, so there is no ticker; expected growth
        # and volatility are supplied explicitly.
        amt = client.amt_iso(
            shares=8000,
            strike=3.0,
            fmv=40.0,
            filingStatus="single",
            ordinaryIncome=250000,
            stateCode="CA",
            carryforwardCredit=0,
            horizon=5,
            cashReturnRate=0.04,
            grantDate="2022-03-01",
            hasLeftCompany=False,
            terminationDate=None,
            expectedGrowth=0.12,
            volatility=0.5,
        )["result"]
        print("1. ISO / AMT optimizer")
        print(f"   optimized net final value: {usd(amt['schedules']['optimized']['nfv'])}")
        print(f"   up to {amt['crossoverShares']:,} shares in year 1 before AMT bites")
        print()

        # 2) NSO: tax and after-tax proceeds of exercising, hold versus sell. A covered
        # ticker lets the API derive expected return and volatility.
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
        )["result"]
        edge = nso["holdMinusCashless"]
        print("2. NSO exercise")
        print(f"   ordinary income at exercise: {usd(nso['exercise']['bargainElement'])}")
        print(f"   holding beats selling now by {usd(edge)}" if edge > 0
              else f"   selling now beats holding by {usd(-edge)}")
        print()

        # 3) RSU: sell at vest versus hold, on an after-tax, risk-adjusted basis.
        rsu = client.rsu_sell_vs_hold(
            shares=2000,
            currentPrice=50.0,
            ordinaryIncome=220000,
            filingStatus="single",
            stateCode="CA",
            stillEmployed=True,
            holdYears=2,
            ticker="NVDA",
        )["result"]
        edge = rsu["holdMinusSell"]
        print("3. RSU sell versus hold")
        print(f"   holding beats selling at vest by {usd(edge)}" if edge > 0
              else f"   selling at vest beats holding by {usd(-edge)}")
        print()

        # 4) Concentration: single-stock risk and the after-tax cost of diversifying.
        conc = client.concentration(
            positionValue=400000,
            costBasis=100000,
            acquisitionDate="2022-01-01",
            sector="tech_software",
            stateCode="CA",
            filingStatus="single",
            ordinaryIncome=200000,
            totalAssets=1200000,
            ticker="NVDA",
        )["result"]
        print("4. Concentration analysis")
        print(f"   risk band: {conc['riskBand']} "
              f"({conc['concentration'] * 100:.0f}% of the portfolio)")
        print()

        # 5) Protective put: price downside protection (a bare put, a zero-cost
        # collar, and a put spread) for a position. The sector sets a default
        # volatility; spreadRiskLevel tunes only the put spread's short strike.
        put = client.protective_put(
            positionValue=400000,
            sector="tech_software",
            protectionLevel=0.10,
            tenorYears=1,
            spreadRiskLevel=0.10,
        )["result"]
        print("5. Protective put pricing")
        print(f"   bare put costs {put['barePut']['annualCostPct'] * 100:.1f}% per year "
              f"for 10% downside protection")
        spread = put.get("putSpread")
        if spread is not None:
            print(f"   put spread costs {spread['annualCostPct'] * 100:.1f}% per year, "
                  f"with losses resuming below the short strike")
        print(f"   recommended structure: {put['recommended']}")
        print()

        # 6) QSBS: can this founder exclude gain on a planned sale?
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
        )["result"]
        print("6. QSBS eligibility")
        print(f"   verdict: {qsbs['verdict']}; "
              f"excludable gain {usd(qsbs['excludableGain'])}")
        print()

        # 7) Equity funding: which lots to sell, and when, to raise an after-tax cash
        # goal by a target date at the least tax cost. Holdings are passed as a stack
        # of lots; a covered ticker supplies the forward-looking growth and volatility.
        funding = client.equity_funding(
            targetAfterTax=300000,
            targetDate="2027-06-01",
            ordinaryIncome=250000,
            filingStatus="single",
            stateCode="CA",
            stacks=[
                {
                    "currentPrice": 50.0,
                    "ticker": "NVDA",
                    "lots": [
                        {
                            "shares": 10000,
                            "costBasisPerShare": 8.0,
                            "acquisitionDate": "2022-01-01",
                        }
                    ],
                }
            ],
        )["result"]
        plan = funding["recommended"]["plan"]
        print("7. Equity funding plan")
        print(f"   sell {plan['totalSharesSold']:,} shares to raise "
              f"{usd(plan['totalAfterTaxAchieved'])} after tax by the target date")
        print()

        # 8) RSU lot order: which vested RSU lots to sell, and when, to divest a
        # target fraction at the lowest tax, versus a first-in-first-out sell order.
        lot_order = client.rsu_lot_order(
            lots=[
                {"vestDate": "2022-08-15", "shares": 120, "costBasisPerShare": 95},
                {"vestDate": "2024-02-15", "shares": 100, "costBasisPerShare": 130},
                {"vestDate": "2026-05-15", "shares": 80, "costBasisPerShare": 210},
            ],
            currentPrice=180,
            divestFraction=0.5,
            horizonYears=2,
            ordinaryIncome=200000,
            filingStatus="single",
            stateCode="CA",
        )["result"]
        print("8. RSU lot sell order")
        print(f"   optimized order saves {usd(lot_order['headlineDeltaVsFifo'])} "
              f"in tax versus selling first-in-first-out")
    except OptionsAhoyError as err:
        print(f"OptionsAhoy API error: {err}")
        print(f"  status_code={err.status_code} payload={err.payload}")


if __name__ == "__main__":
    main()
