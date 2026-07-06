# AlphaLatitude Inc. © 2026
"""Arcade tools for the OptionsAhoy calculators.

One ``@tool``-decorated function per public endpoint. Each function's parameters use
``typing.Annotated[type, "description"]`` so the Arcade engine can build the input schema,
mirroring the endpoint's required and optional fields exactly as published in the OpenAPI
schema at https://optionsahoy.com/openapi.json. Tool descriptions (the docstrings) say what
each tool computes, not how, and deabbreviate acronyms on first use.

Every function instantiates the keyless ``OptionsAhoyClient`` (no account, no application
programming interface (API) key) and returns the parsed response dict. The base URL can be
overridden with the ``OPTIONSAHOY_BASE_URL`` environment variable.
"""

import os
from typing import Annotated, Any, Dict, List, Optional

from arcade_tdk import tool
from optionsahoy import OptionsAhoyClient


def _client() -> OptionsAhoyClient:
    """Build a keyless OptionsAhoy client, honoring an optional base-URL override."""
    base_url = os.environ.get("OPTIONSAHOY_BASE_URL")
    return OptionsAhoyClient(base_url) if base_url else OptionsAhoyClient()


@tool
def amt_iso_optimize(
    shares: Annotated[int, "Number of incentive stock option (ISO) shares available to exercise."],
    strike: Annotated[float, "Exercise (strike) price per share, in US dollars."],
    fmv: Annotated[float, "Current fair market value per share, in US dollars."],
    filing_status: Annotated[
        str, "Tax filing status: 'single', 'married_joint', or 'head_household'."
    ],
    ordinary_income: Annotated[float, "Annual ordinary income before this exercise, in US dollars."],
    state_code: Annotated[str, "Two-letter US state code, or 'DC'."],
    carryforward_credit: Annotated[
        float, "Existing alternative minimum tax (AMT) credit carryforward, in US dollars."
    ],
    horizon: Annotated[int, "Planning horizon in years (1 to 10)."],
    cash_return_rate: Annotated[
        float, "Annual return on cash held instead of exercising, as a decimal (for example 0.04)."
    ],
    grant_date: Annotated[str, "ISO grant date in ISO-8601 format (YYYY-MM-DD)."],
    has_left_company: Annotated[bool, "Whether the holder has left the company."],
    termination_date: Annotated[
        Optional[str], "Termination date (YYYY-MM-DD), or null if still employed."
    ] = None,
    expected_growth: Annotated[
        Optional[float], "Expected annual share-price growth, as a decimal."
    ] = None,
    ticker: Annotated[
        Optional[str], "Covered public ticker to source expected return from (for example 'NVDA')."
    ] = None,
    volatility_drag: Annotated[Optional[float], "Volatility drag factor (0 to 0.99)."] = None,
    volatility: Annotated[Optional[float], "Annualized volatility of the stock, as a decimal."] = None,
) -> Annotated[Dict[str, Any], "The optimized multi-year ISO exercise schedule and tax breakdown."]:
    """Optimize a multi-year incentive stock option (ISO) exercise schedule under the alternative
    minimum tax (AMT): how many shares to exercise each year so the after-tax outcome is best.
    Returns three strategies (lump sum, even split, optimized) with per-year federal and state tax,
    AMT owed and credit, and the net future value of each schedule."""
    with _client() as client:
        return client.amt_iso(
            shares=shares,
            strike=strike,
            fmv=fmv,
            filingStatus=filing_status,
            ordinaryIncome=ordinary_income,
            stateCode=state_code,
            carryforwardCredit=carryforward_credit,
            horizon=horizon,
            cashReturnRate=cash_return_rate,
            grantDate=grant_date,
            hasLeftCompany=has_left_company,
            terminationDate=termination_date,
            expectedGrowth=expected_growth,
            ticker=ticker,
            volatilityDrag=volatility_drag,
            volatility=volatility,
        )


@tool
def nso_calculate(
    shares: Annotated[int, "Number of non-qualified stock option (NSO) shares to exercise."],
    strike: Annotated[float, "Exercise (strike) price per share, in US dollars."],
    current_price: Annotated[float, "Current share price, in US dollars."],
    ordinary_income: Annotated[float, "Annual ordinary income before this exercise, in US dollars."],
    filing_status: Annotated[
        str, "Tax filing status: 'single', 'married_joint', or 'head_household'."
    ],
    state_code: Annotated[str, "Two-letter US state code, or 'DC'."],
    still_employed: Annotated[
        bool, "Whether the holder is still employed (payroll taxes differ once separated)."
    ],
    hold_years: Annotated[float, "Years the shares are held after exercise (at least 1)."],
    hold_funding: Annotated[
        str, "How the exercise is funded: 'sell-to-cover' or 'cash'."
    ],
    expected_sale_price: Annotated[
        Optional[float], "Expected sale price per share, in US dollars."
    ] = None,
    haircut: Annotated[Optional[float], "Risk haircut on expected upside (0 to 1)."] = None,
    volatility: Annotated[Optional[float], "Annualized volatility of the stock, as a decimal."] = None,
    expected_market_return: Annotated[
        Optional[float], "Expected broad-market annual return, as a decimal."
    ] = None,
    ticker: Annotated[
        Optional[str], "Covered public ticker to source expected return from."
    ] = None,
) -> Annotated[Dict[str, Any], "Exercise tax, the sell-at-exercise path, and the hold path."]:
    """Compute the tax and after-tax proceeds of exercising non-qualified stock options (NSOs),
    comparing selling at exercise against holding for later long-term capital gains. Returns the
    ordinary-income tax at exercise, the marginal-rate bracket jump, and the net wealth of the hold
    versus sell-now-and-invest paths."""
    with _client() as client:
        return client.nso(
            shares=shares,
            strike=strike,
            currentPrice=current_price,
            ordinaryIncome=ordinary_income,
            filingStatus=filing_status,
            stateCode=state_code,
            stillEmployed=still_employed,
            holdYears=hold_years,
            holdFunding=hold_funding,
            expectedSalePrice=expected_sale_price,
            haircut=haircut,
            volatility=volatility,
            expectedMarketReturn=expected_market_return,
            ticker=ticker,
        )


@tool
def rsu_sell_vs_hold(
    shares: Annotated[int, "Number of vested restricted stock unit (RSU) shares."],
    current_price: Annotated[float, "Current share price, in US dollars."],
    ordinary_income: Annotated[float, "Annual ordinary income, in US dollars."],
    filing_status: Annotated[
        str, "Tax filing status: 'single', 'married_joint', or 'head_household'."
    ],
    state_code: Annotated[str, "Two-letter US state code, or 'DC'."],
    still_employed: Annotated[bool, "Whether the holder is still employed."],
    hold_years: Annotated[float, "Years to hold after vest (0.25 to 5)."],
    expected_sale_price: Annotated[
        Optional[float], "Expected sale price per share, in US dollars."
    ] = None,
    haircut: Annotated[Optional[float], "Risk haircut on expected upside (0 to 1)."] = None,
    volatility: Annotated[Optional[float], "Annualized volatility of the stock, as a decimal."] = None,
    expected_market_return: Annotated[
        Optional[float], "Expected broad-market annual return, as a decimal."
    ] = None,
    ticker: Annotated[
        Optional[str], "Covered public ticker to source expected return from."
    ] = None,
) -> Annotated[Dict[str, Any], "Vest tax, the hold path, and the sell-now-and-invest path."]:
    """Compare selling vested restricted stock units (RSUs) at vest against holding them, on an
    after-tax, risk-adjusted basis. Returns the tax due at vest, the marginal-rate bracket jump,
    and which choice (hold or sell now and invest) is expected to leave more wealth."""
    with _client() as client:
        return client.rsu_sell_vs_hold(
            shares=shares,
            currentPrice=current_price,
            ordinaryIncome=ordinary_income,
            filingStatus=filing_status,
            stateCode=state_code,
            stillEmployed=still_employed,
            holdYears=hold_years,
            expectedSalePrice=expected_sale_price,
            haircut=haircut,
            volatility=volatility,
            expectedMarketReturn=expected_market_return,
            ticker=ticker,
        )


@tool
def concentration_analyze(
    position_value: Annotated[float, "Current market value of the position, in US dollars."],
    cost_basis: Annotated[float, "Total cost basis of the position, in US dollars."],
    acquisition_date: Annotated[
        str, "Earliest lot acquisition date (YYYY-MM-DD); sets the one-year long-term threshold."
    ],
    sector: Annotated[
        str,
        "Sector of the stock, one of: 'tech_software', 'semiconductors', 'consumer_cyclical', "
        "'consumer_defensive', 'financials', 'healthcare_biotech', 'energy', 'industrials', "
        "'communication', 'broad_market'. Sets default volatility.",
    ],
    state_code: Annotated[str, "Two-letter US state code, or 'DC'."],
    filing_status: Annotated[
        str, "Tax filing status: 'single', 'married_joint', or 'head_household'."
    ],
    ordinary_income: Annotated[float, "Annual ordinary income, in US dollars."],
    total_assets: Annotated[
        float, "Whole investable portfolio including this position, in US dollars."
    ],
    expected_position_return: Annotated[
        Optional[float], "Expected annual return of the position, as a decimal."
    ] = None,
    expected_market_return: Annotated[
        Optional[float], "Expected broad-market annual return, as a decimal."
    ] = None,
    ticker: Annotated[
        Optional[str], "Covered public ticker to derive expected returns from."
    ] = None,
    volatility_drag: Annotated[Optional[float], "Volatility drag factor (0 to 0.99)."] = None,
    volatility: Annotated[Optional[float], "Annualized volatility of the stock, as a decimal."] = None,
    hedge_choice: Annotated[
        Optional[Dict[str, Any]],
        "Optional hedge to evaluate, with keys 'kind' (put or collar), 'protectionLevel', "
        "'tenorYears', 'upsideCapPct'.",
    ] = None,
) -> Annotated[Dict[str, Any], "Concentration metrics, sell-down plans, and optional hedge pricing."]:
    """Quantify single-stock concentration risk and compare the after-tax cost of three responses:
    sell down, hold, or hedge. Returns the position's share of total assets, a risk band, loss
    exposure at several drawdowns, after-tax sell-down plans, and hedge pricing when a hedge is
    given."""
    with _client() as client:
        return client.concentration(
            positionValue=position_value,
            costBasis=cost_basis,
            acquisitionDate=acquisition_date,
            sector=sector,
            stateCode=state_code,
            filingStatus=filing_status,
            ordinaryIncome=ordinary_income,
            totalAssets=total_assets,
            expectedPositionReturn=expected_position_return,
            expectedMarketReturn=expected_market_return,
            ticker=ticker,
            volatilityDrag=volatility_drag,
            volatility=volatility,
            hedgeChoice=hedge_choice,
        )


@tool
def protective_put_price(
    position_value: Annotated[float, "Market value of the position to hedge, in US dollars."],
    sector: Annotated[
        str,
        "Sector of the stock, one of: 'tech_software', 'semiconductors', 'consumer_cyclical', "
        "'consumer_defensive', 'financials', 'healthcare_biotech', 'energy', 'industrials', "
        "'communication', 'broad_market'. Sets default volatility.",
    ],
    protection_level: Annotated[
        float, "Downside protected, as a fraction (0.05 to 0.5)."
    ],
    tenor_years: Annotated[float, "Hedge tenor in years (at least 0.25)."],
    volatility: Annotated[Optional[float], "Annualized volatility of the stock, as a decimal."] = None,
    expected_return: Annotated[
        Optional[float], "Expected annual return of the stock, as a decimal."
    ] = None,
    ticker_label: Annotated[Optional[str], "Display label for the ticker."] = None,
    spread_risk_level: Annotated[
        Optional[float],
        "Put spread floor breach risk: probability the stock ends below the spread's short strike "
        "(presets 0.20 / 0.10 / 0.05 / 0.01, i.e. 1 in 5 / 10 / 20 / 100; off-preset snaps to the "
        "nearest). Affects only the putSpread block. Default 0.10.",
    ] = None,
) -> Annotated[
    Dict[str, Any],
    "Bare put, zero-cost collar, and put spread pricing with a payoff table.",
]:
    """Price a protective put, a zero-cost collar, and a put spread for a stock position at a chosen
    downside-protection level and tenor. Returns the put premium and annual cost, the collar's
    put and call strikes and upside cap, the put spread's long and short strikes and net cost, a
    profit-and-loss payoff table across drawdowns, and a recommendation."""
    with _client() as client:
        return client.protective_put(
            positionValue=position_value,
            sector=sector,
            protectionLevel=protection_level,
            tenorYears=tenor_years,
            volatility=volatility,
            expectedReturn=expected_return,
            tickerLabel=ticker_label,
            spreadRiskLevel=spread_risk_level,
        )


@tool
def qsbs_check(
    acquisition_date: Annotated[str, "Stock acquisition date (YYYY-MM-DD)."],
    sale_date: Annotated[str, "Planned sale date (YYYY-MM-DD); the gap sets the holding period."],
    entity_type: Annotated[str, "Issuer entity type: 'us-c-corp' or 'other'."],
    acquisition_method: Annotated[
        str,
        "How the stock was acquired: 'original-issuance', 'gift-or-inheritance', 'secondary', "
        "or 'unsure'.",
    ],
    asset_category: Annotated[
        str,
        "Issuer gross assets at issuance: 'under-50m', '50m-to-75m', 'over-75m', or 'unsure'.",
    ],
    industry: Annotated[
        str,
        "Issuer industry, one of: 'tech-software', 'manufacturing', 'biotech-research', "
        "'retail-wholesale', 'health-services', 'law', 'engineering', 'architecture', "
        "'accounting-actuarial', 'consulting', 'finance', 'farming', 'extraction', "
        "'hospitality', 'performing-arts', 'other-services', or 'unsure'.",
    ],
    active_business: Annotated[
        str, "Whether the issuer meets the active-business requirement: 'yes', 'no', or 'unsure'."
    ],
    adjusted_basis: Annotated[float, "Adjusted basis in the stock, in US dollars."],
    expected_gain: Annotated[float, "Expected gain on sale, in US dollars."],
    state_code: Annotated[str, "Two-letter US state code, or 'DC'."],
    ordinary_income: Annotated[float, "Annual ordinary income, in US dollars."],
    filing_status: Annotated[
        str, "Tax filing status: 'single', 'married_joint', or 'head_household'."
    ],
) -> Annotated[Dict[str, Any], "QSBS verdict, exclusion percent, caps, and tax saved."]:
    """Check qualified small business stock (QSBS) Section 1202 eligibility and compute the
    resulting federal capital-gains exclusion on a planned sale. Returns a verdict, the exclusion
    percent, the binding per-issuer or ten-times-basis cap, excludable and taxable gain, federal
    tax saved, state conformity, and the individual eligibility tests."""
    with _client() as client:
        return client.qsbs(
            acquisitionDate=acquisition_date,
            saleDate=sale_date,
            entityType=entity_type,
            acquisitionMethod=acquisition_method,
            assetCategory=asset_category,
            industry=industry,
            activeBusiness=active_business,
            adjustedBasis=adjusted_basis,
            expectedGain=expected_gain,
            stateCode=state_code,
            ordinaryIncome=ordinary_income,
            filingStatus=filing_status,
        )


@tool
def equity_funding_plan(
    target_after_tax: Annotated[float, "After-tax cash goal to raise, in US dollars."],
    target_date: Annotated[str, "Date the cash is needed (YYYY-MM-DD)."],
    ordinary_income: Annotated[float, "Annual ordinary income, in US dollars."],
    filing_status: Annotated[
        str, "Tax filing status: 'single', 'married_joint', or 'head_household'."
    ],
    state_code: Annotated[str, "Two-letter US state code, or 'DC'."],
    stacks: Annotated[
        Optional[List[Dict[str, Any]]],
        "Preferred holdings format. A list of stacks, each with 'currentPrice' and a 'lots' list "
        "of {shares, costBasisPerShare, acquisitionDate, vestDate?}; optional per-stack 'ticker', "
        "'expectedAnnualGrowth', 'volatility'.",
    ] = None,
    lots: Annotated[
        Optional[List[Dict[str, Any]]],
        "Legacy single-stack lots list (use with current_price).",
    ] = None,
    current_price: Annotated[
        Optional[float], "Legacy single-stack current price, in US dollars."
    ] = None,
    expected_annual_growth: Annotated[
        Optional[float], "Expected annual share-price growth, as a decimal."
    ] = None,
    cash_interest_rate: Annotated[
        Optional[float], "Annual interest rate on idle cash, as a decimal."
    ] = None,
    risk_tolerance_shortfall: Annotated[
        Optional[float], "Acceptable probability of shortfall (0 to 1)."
    ] = None,
    default_volatility: Annotated[
        Optional[float], "Default annualized volatility, as a decimal."
    ] = None,
    today: Annotated[Optional[str], "Override for today's date (YYYY-MM-DD)."] = None,
) -> Annotated[Dict[str, Any], "Named funding plans, the risk/return frontier, and per-year sales."]:
    """Plan which equity lots to sell, and when, to fund a cash goal by a target date at the least
    after-tax cost, accounting for holding-period thresholds and shortfall risk. Returns four named
    plans (recommended, lock in now, balanced, hold for growth) plus the full frontier, each with
    projected wealth, total tax, shortfall probability, and a per-year sale schedule. Provide
    'stacks' (preferred) or the legacy 'lots' plus 'current_price'."""
    with _client() as client:
        return client.equity_funding(
            targetAfterTax=target_after_tax,
            targetDate=target_date,
            ordinaryIncome=ordinary_income,
            filingStatus=filing_status,
            stateCode=state_code,
            stacks=stacks,
            lots=lots,
            currentPrice=current_price,
            expectedAnnualGrowth=expected_annual_growth,
            cashInterestRate=cash_interest_rate,
            riskToleranceShortfall=risk_tolerance_shortfall,
            defaultVolatility=default_volatility,
            today=today,
        )
