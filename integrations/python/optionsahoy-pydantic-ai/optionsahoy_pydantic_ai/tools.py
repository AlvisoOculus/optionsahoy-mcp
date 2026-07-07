# AlphaLatitude Inc. © 2026
"""Pydantic AI tools for the OptionsAhoy calculators.

One ``pydantic_ai.Tool`` per public endpoint, built with ``Tool.from_schema`` from
a pydantic v2 model that mirrors the endpoint's required and optional fields exactly
as published in the OpenAPI schema at https://optionsahoy.com/openapi.json. Tool
descriptions say what each tool computes, not how, and deabbreviate acronyms on
first use.

Every tool forwards to the shared, keyless ``optionsahoy`` REST client; no HTTP is
reimplemented here and no application programming interface (API) key is read,
stored, or sent anywhere.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from optionsahoy import OptionsAhoyClient
from pydantic import BaseModel, Field
from pydantic_ai import Agent, Tool
from pydantic_ai.toolsets.function import FunctionToolset

FilingStatus = Literal["single", "married_joint", "head_household"]
SectorKey = Literal[
    "tech_software",
    "semiconductors",
    "consumer_cyclical",
    "consumer_defensive",
    "financials",
    "healthcare_biotech",
    "energy",
    "industrials",
    "communication",
    "broad_market",
]


# --- args schemas (mirror the OpenAPI request bodies one for one) ----------


class AmtIsoArgs(BaseModel):
    """Inputs for the incentive stock option (ISO) / alternative minimum tax (AMT)
    multi-year exercise optimizer."""

    shares: int = Field(..., ge=1, description="Number of ISO shares available to exercise.")
    strike: float = Field(..., ge=0, description="Exercise (strike) price per share.")
    fmv: float = Field(..., ge=0, description="Current fair market value per share.")
    filingStatus: FilingStatus = Field(..., description="Tax filing status.")
    ordinaryIncome: float = Field(..., ge=0, description="Annual ordinary income before this exercise.")
    stateCode: str = Field(..., description="Two-letter US state code, or DC.")
    carryforwardCredit: float = Field(..., ge=0, description="Existing AMT credit carryforward.")
    horizon: int = Field(..., ge=1, le=10, description="Planning horizon in years (1 to 10).")
    cashReturnRate: float = Field(..., description="Annual return on cash held instead of exercising.")
    grantDate: str = Field(..., description="ISO grant date, ISO-8601 (YYYY-MM-DD).")
    hasLeftCompany: bool = Field(..., description="Whether the holder has left the company.")
    terminationDate: Optional[str] = Field(
        ..., description="Termination date (YYYY-MM-DD), or null if still employed."
    )
    expectedGrowth: Optional[float] = Field(None, description="Expected annual share-price growth.")
    ticker: Optional[str] = Field(None, description="Public ticker to source expected return from.")
    volatilityDrag: Optional[float] = Field(None, ge=0, le=0.99, description="Volatility drag factor.")
    volatility: Optional[float] = Field(None, ge=0, description="Annualized volatility of the stock.")


class NsoArgs(BaseModel):
    """Inputs for the non-qualified stock option (NSO) exercise calculator."""

    shares: int = Field(..., ge=1, description="Number of NSO shares to exercise.")
    strike: float = Field(..., ge=0, description="Exercise (strike) price per share.")
    currentPrice: float = Field(..., ge=0, description="Current share price.")
    ordinaryIncome: float = Field(..., ge=0, description="Annual ordinary income before this exercise.")
    filingStatus: FilingStatus = Field(..., description="Tax filing status.")
    stateCode: str = Field(..., description="Two-letter US state code, or DC.")
    stillEmployed: bool = Field(..., description="Whether the holder is still employed.")
    holdYears: float = Field(..., ge=1, description="Years the shares are held after exercise.")
    holdFunding: Literal["sell-to-cover", "cash"] = Field(
        ..., description="How the exercise is funded."
    )
    expectedSalePrice: Optional[float] = Field(None, ge=0, description="Expected sale price per share.")
    haircut: Optional[float] = Field(None, ge=0, le=1, description="Risk haircut on expected upside.")
    volatility: Optional[float] = Field(None, ge=0, description="Annualized volatility of the stock.")
    expectedMarketReturn: Optional[float] = Field(None, description="Expected broad-market annual return.")
    ticker: Optional[str] = Field(None, description="Public ticker to source expected return from.")


class RsuArgs(BaseModel):
    """Inputs for the restricted stock unit (RSU) sell-versus-hold comparison."""

    shares: int = Field(..., ge=1, description="Number of vested RSU shares.")
    currentPrice: float = Field(..., ge=0, description="Current share price.")
    ordinaryIncome: float = Field(..., ge=0, description="Annual ordinary income.")
    filingStatus: FilingStatus = Field(..., description="Tax filing status.")
    stateCode: str = Field(..., description="Two-letter US state code, or DC.")
    stillEmployed: bool = Field(..., description="Whether the holder is still employed.")
    holdYears: float = Field(..., ge=0.25, le=5, description="Years to hold (0.25 to 5).")
    expectedSalePrice: Optional[float] = Field(None, ge=0, description="Expected sale price per share.")
    haircut: Optional[float] = Field(None, ge=0, le=1, description="Risk haircut on expected upside.")
    volatility: Optional[float] = Field(None, ge=0, description="Annualized volatility of the stock.")
    expectedMarketReturn: Optional[float] = Field(None, description="Expected broad-market annual return.")
    ticker: Optional[str] = Field(None, description="Public ticker to source expected return from.")


class ConcentrationArgs(BaseModel):
    """Inputs for the concentrated single-stock position analysis."""

    positionValue: float = Field(..., ge=0, description="Current market value of the position.")
    costBasis: float = Field(..., ge=0, description="Total cost basis of the position.")
    acquisitionDate: str = Field(..., description="Acquisition date, ISO-8601 (YYYY-MM-DD).")
    sector: SectorKey = Field(..., description="Sector of the concentrated stock.")
    stateCode: str = Field(..., description="Two-letter US state code, or DC.")
    filingStatus: FilingStatus = Field(..., description="Tax filing status.")
    ordinaryIncome: float = Field(..., ge=0, description="Annual ordinary income.")
    totalAssets: float = Field(..., ge=0, description="Total investable assets including this position.")
    expectedPositionReturn: Optional[float] = Field(None, description="Expected annual return of the position.")
    expectedMarketReturn: Optional[float] = Field(None, description="Expected broad-market annual return.")
    ticker: Optional[str] = Field(None, description="Public ticker to source expected return from.")
    volatilityDrag: Optional[float] = Field(None, ge=0, le=0.99, description="Volatility drag factor.")
    volatility: Optional[float] = Field(None, ge=0, description="Annualized volatility of the stock.")
    hedgeChoice: Optional[Dict[str, Any]] = Field(
        None,
        description=(
            "Optional hedge to evaluate, with keys kind, protectionLevel, tenorYears, "
            "upsideCapPct."
        ),
    )


class ProtectivePutArgs(BaseModel):
    """Inputs for protective put hedge pricing."""

    positionValue: float = Field(..., ge=0, description="Market value of the position to hedge.")
    sector: SectorKey = Field(..., description="Sector of the stock being hedged.")
    protectionLevel: float = Field(
        ..., ge=0.05, le=0.5, description="Downside protected, as a fraction (0.05 to 0.5)."
    )
    tenorYears: float = Field(..., ge=0.25, description="Hedge tenor in years.")
    volatility: Optional[float] = Field(None, ge=0, description="Annualized volatility of the stock.")
    expectedReturn: Optional[float] = Field(None, description="Expected annual return of the stock.")
    ticker: Optional[str] = Field(None, description="Public ticker to source implied volatility from.")
    tickerLabel: Optional[str] = Field(None, description="Display label for the ticker.")
    spreadRiskLevel: Optional[float] = Field(
        None,
        ge=0.01,
        le=0.2,
        description=(
            "Put spread floor breach risk: probability the stock ends below the spread's short "
            "strike (presets 0.20 / 0.10 / 0.05 / 0.01, i.e. 1 in 5 / 10 / 20 / 100; off-preset "
            "snaps to the nearest). Affects only the putSpread block. Default 0.10."
        ),
    )


class QsbsArgs(BaseModel):
    """Inputs for the qualified small business stock (QSBS) eligibility check."""

    acquisitionDate: str = Field(..., description="Stock acquisition date (YYYY-MM-DD).")
    saleDate: str = Field(..., description="Planned sale date (YYYY-MM-DD).")
    entityType: Literal["us-c-corp", "other"] = Field(..., description="Issuer entity type.")
    acquisitionMethod: Literal[
        "original-issuance", "gift-or-inheritance", "secondary", "unsure"
    ] = Field(..., description="How the stock was acquired.")
    assetCategory: Literal["under-50m", "50m-to-75m", "over-75m", "unsure"] = Field(
        ..., description="Issuer gross assets at issuance."
    )
    industry: Literal[
        "tech-software",
        "manufacturing",
        "biotech-research",
        "retail-wholesale",
        "health-services",
        "law",
        "engineering",
        "architecture",
        "accounting-actuarial",
        "consulting",
        "finance",
        "farming",
        "extraction",
        "hospitality",
        "performing-arts",
        "other-services",
        "unsure",
    ] = Field(..., description="Issuer industry.")
    activeBusiness: Literal["yes", "no", "unsure"] = Field(
        ..., description="Whether the issuer meets the active-business requirement."
    )
    adjustedBasis: float = Field(..., ge=0, description="Adjusted basis in the stock.")
    expectedGain: float = Field(..., description="Expected gain on sale.")
    stateCode: str = Field(..., description="Two-letter US state code, or DC.")
    ordinaryIncome: float = Field(..., ge=0, description="Annual ordinary income.")
    filingStatus: FilingStatus = Field(..., description="Tax filing status.")


class EquityFundingArgs(BaseModel):
    """Inputs for planning equity sales to fund a cash goal by a target date.

    Provide ``stacks`` (preferred) or the legacy ``lots`` plus ``currentPrice``.
    """

    targetAfterTax: float = Field(..., ge=0, description="After-tax cash goal to raise.")
    targetDate: str = Field(..., description="Date the cash is needed (YYYY-MM-DD).")
    ordinaryIncome: float = Field(..., ge=0, description="Annual ordinary income.")
    filingStatus: FilingStatus = Field(..., description="Tax filing status.")
    stateCode: str = Field(..., description="Two-letter US state code, or DC.")
    stacks: Optional[List[Dict[str, Any]]] = Field(
        None,
        description=(
            "Preferred. List of stacks, each with currentPrice and a lots list; optional "
            "ticker, expectedAnnualGrowth, volatility per stack. Each lot has shares, "
            "costBasisPerShare, acquisitionDate, and optional vestDate."
        ),
    )
    lots: Optional[List[Dict[str, Any]]] = Field(
        None, description="Legacy single-stack lots list (use with currentPrice)."
    )
    currentPrice: Optional[float] = Field(None, ge=0, description="Legacy single-stack current price.")
    expectedAnnualGrowth: Optional[float] = Field(None, description="Expected annual share-price growth.")
    cashInterestRate: Optional[float] = Field(None, description="Annual interest rate on idle cash.")
    riskToleranceShortfall: Optional[float] = Field(
        None, ge=0, le=1, description="Acceptable probability of shortfall (0 to 1)."
    )
    defaultVolatility: Optional[float] = Field(None, ge=0, description="Default annualized volatility.")
    today: Optional[str] = Field(None, description="Override for today's date (YYYY-MM-DD).")


# --- tool factory ----------------------------------------------------------

_SPECS = [
    (
        "optionsahoy_amt_iso_optimize",
        "amt_iso",
        AmtIsoArgs,
        "Optimize a multi-year incentive stock option (ISO) exercise schedule under the "
        "alternative minimum tax (AMT). Returns the after-tax-optimal number of shares to "
        "exercise each year across the planning horizon, with the federal and state tax for "
        "each path.",
    ),
    (
        "optionsahoy_nso_calculate",
        "nso",
        NsoArgs,
        "Calculate the tax and after-tax proceeds of exercising non-qualified stock options "
        "(NSOs) and holding versus selling, including ordinary-income tax at exercise and "
        "capital-gains treatment on later sale.",
    ),
    (
        "optionsahoy_rsu_sell_vs_hold",
        "rsu_sell_vs_hold",
        RsuArgs,
        "Compare selling vested restricted stock units (RSUs) at vest against holding them, "
        "on an after-tax, risk-adjusted basis, and return which choice is expected to leave "
        "more wealth.",
    ),
    (
        "optionsahoy_concentration_analyze",
        "concentration",
        ConcentrationArgs,
        "Analyze a concentrated single-stock position: its share of total assets, the "
        "after-tax cost of diversifying, and the risk reduction from selling down or hedging.",
    ),
    (
        "optionsahoy_protective_put_price",
        "protective_put",
        ProtectivePutArgs,
        "Price three hedge structures for a stock position at a chosen downside protection level "
        "and tenor (protective put, zero-cost collar, and put spread), returning the estimated "
        "premium and net cost of each and a recommendation.",
    ),
    (
        "optionsahoy_qsbs_check",
        "qsbs",
        QsbsArgs,
        "Check qualified small business stock (QSBS) eligibility and compute the resulting "
        "federal and state capital-gains exclusion on a planned sale.",
    ),
    (
        "optionsahoy_equity_funding_plan",
        "equity_funding",
        EquityFundingArgs,
        "Plan which equity lots to sell, and when, to fund a cash goal by a target date with "
        "the least after-tax cost, accounting for holding-period thresholds and shortfall risk.",
    ),
]


def _make_forward(client: OptionsAhoyClient, method_name: str):
    """Build the keyword-only forwarder Pydantic AI calls with the validated arguments.

    ``Tool.from_schema`` invokes this with keywords only. The shared client drops unset
    optional fields before the request, so forwarding exactly the supplied fields works.
    """

    def _forward(**kwargs: Any) -> Dict[str, Any]:
        method = getattr(client, method_name)
        return method(**kwargs)

    return _forward


def get_optionsahoy_tools(client: Optional[OptionsAhoyClient] = None) -> List[Tool]:
    """Return one Pydantic AI ``Tool`` per OptionsAhoy calculator endpoint.

    Pass the list straight to an agent::

        from pydantic_ai import Agent
        from optionsahoy_pydantic_ai import get_optionsahoy_tools

        agent = Agent("openai:gpt-4o-mini", tools=get_optionsahoy_tools())

    Args:
        client: Optional pre-configured ``OptionsAhoyClient``. A default keyless client
            pointing at https://optionsahoy.com is used when omitted.

    Returns:
        A list of ``pydantic_ai.Tool`` objects, each with a name, description, and JSON
        schema mirroring the underlying endpoint.
    """
    oa = client or OptionsAhoyClient()
    tools: List[Tool] = []
    for name, method_name, args_model, description in _SPECS:
        tools.append(
            Tool.from_schema(
                _make_forward(oa, method_name),
                name=name,
                description=description,
                json_schema=args_model.model_json_schema(),
            )
        )
    return tools


def optionsahoy_toolset(client: Optional[OptionsAhoyClient] = None) -> FunctionToolset:
    """Return a ``FunctionToolset`` holding all seven OptionsAhoy tools.

    Pass it to an agent as a toolset::

        agent = Agent("openai:gpt-4o-mini", toolsets=[optionsahoy_toolset()])
    """
    return FunctionToolset(get_optionsahoy_tools(client))


def register_optionsahoy_tools(
    agent: Agent, client: Optional[OptionsAhoyClient] = None
) -> List[Tool]:
    """Register all seven OptionsAhoy tools onto an existing ``Agent``.

    Use this to add the tools to an agent that is already constructed::

        agent = Agent("openai:gpt-4o-mini")
        register_optionsahoy_tools(agent)

    Args:
        agent: The Pydantic AI agent to add the tools to.
        client: Optional pre-configured ``OptionsAhoyClient``.

    Returns:
        The list of tools that were registered.
    """
    tools = get_optionsahoy_tools(client)
    for tool in tools:
        agent._function_toolset.add_tool(tool)
    return tools
