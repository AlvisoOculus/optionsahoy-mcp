"""CrewAI tools for the OptionsAhoy calculators.

One ``BaseTool`` per public endpoint. Each tool's ``args_schema`` is a pydantic v2 model
mirroring the endpoint's required and optional fields exactly as published in the OpenAPI
schema at https://optionsahoy.com/openapi.json. Tool descriptions say what each tool
computes, not how, and deabbreviate acronyms on first use.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Type

from crewai.tools import BaseTool
from optionsahoy import OptionsAhoyClient
from pydantic import BaseModel, Field

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
    spreadRiskLevel: Optional[float] = Field(
        None,
        ge=0.01,
        le=0.2,
        description=(
            "Put spread floor breach risk: probability the stock ends below the spread's "
            "short strike (presets 0.20 / 0.10 / 0.05 / 0.01, i.e. 1 in 5 / 10 / 20 / 100; "
            "off-preset snaps to the nearest). Affects only the putSpread block. Default 0.10."
        ),
    )
    ticker: Optional[str] = Field(None, description="Public ticker to source implied volatility from.")
    tickerLabel: Optional[str] = Field(None, description="Display label for the ticker.")


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


# --- tool base -------------------------------------------------------------


class _OptionsAhoyTool(BaseTool):
    """Shared base for OptionsAhoy CrewAI tools.

    Subclasses set ``name``, ``description``, ``args_schema``, and ``client_method``
    (the name of the method on ``OptionsAhoyClient`` to call). The configured client is
    held as a private attribute so it is not part of the pydantic tool schema.
    """

    client_method: str = ""

    def __init__(self, client: OptionsAhoyClient, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._client = client

    def _run(self, **kwargs: Any) -> Dict[str, Any]:
        method = getattr(self._client, self.client_method)
        return method(**kwargs)


class AmtIsoTool(_OptionsAhoyTool):
    name: str = "optionsahoy_amt_iso_optimize"
    description: str = (
        "Optimize a multi-year incentive stock option (ISO) exercise schedule under the "
        "alternative minimum tax (AMT). Returns the after-tax-optimal number of shares to "
        "exercise each year across the planning horizon, with the federal and state tax for "
        "each path."
    )
    args_schema: Type[BaseModel] = AmtIsoArgs
    client_method: str = "amt_iso"


class NsoTool(_OptionsAhoyTool):
    name: str = "optionsahoy_nso_calculate"
    description: str = (
        "Calculate the tax and after-tax proceeds of exercising non-qualified stock options "
        "(NSOs) and holding versus selling, including ordinary-income tax at exercise and "
        "capital-gains treatment on later sale."
    )
    args_schema: Type[BaseModel] = NsoArgs
    client_method: str = "nso"


class RsuTool(_OptionsAhoyTool):
    name: str = "optionsahoy_rsu_sell_vs_hold"
    description: str = (
        "Compare selling vested restricted stock units (RSUs) at vest against holding them, "
        "on an after-tax, risk-adjusted basis, and return which choice is expected to leave "
        "more wealth."
    )
    args_schema: Type[BaseModel] = RsuArgs
    client_method: str = "rsu_sell_vs_hold"


class ConcentrationTool(_OptionsAhoyTool):
    name: str = "optionsahoy_concentration_analyze"
    description: str = (
        "Analyze a concentrated single-stock position: its share of total assets, the "
        "after-tax cost of diversifying, and the risk reduction from selling down or hedging."
    )
    args_schema: Type[BaseModel] = ConcentrationArgs
    client_method: str = "concentration"


class ProtectivePutTool(_OptionsAhoyTool):
    name: str = "optionsahoy_protective_put_price"
    description: str = (
        "Price hedges for a stock position at a chosen downside protection level and tenor, "
        "returning the estimated premium and net cost of each structure: a protective put, a "
        "zero-cost collar, and a put spread. The put spread finances the same floor with a "
        "short put instead of a short call, so it is cheaper than the bare put and needs no "
        "shares to write calls against (it works on unexercised employee options a collar "
        "cannot cover); protection stops at the short strike and losses resume below it."
    )
    args_schema: Type[BaseModel] = ProtectivePutArgs
    client_method: str = "protective_put"


class QsbsTool(_OptionsAhoyTool):
    name: str = "optionsahoy_qsbs_check"
    description: str = (
        "Check qualified small business stock (QSBS) eligibility and compute the resulting "
        "federal and state capital-gains exclusion on a planned sale."
    )
    args_schema: Type[BaseModel] = QsbsArgs
    client_method: str = "qsbs"


class EquityFundingTool(_OptionsAhoyTool):
    name: str = "optionsahoy_equity_funding_plan"
    description: str = (
        "Plan which equity lots to sell, and when, to fund a cash goal by a target date with "
        "the least after-tax cost, accounting for holding-period thresholds and shortfall risk."
    )
    args_schema: Type[BaseModel] = EquityFundingArgs
    client_method: str = "equity_funding"


_TOOL_CLASSES = [
    AmtIsoTool,
    NsoTool,
    RsuTool,
    ConcentrationTool,
    ProtectivePutTool,
    QsbsTool,
    EquityFundingTool,
]


def get_optionsahoy_tools(client: Optional[OptionsAhoyClient] = None) -> List[BaseTool]:
    """Return one CrewAI tool per OptionsAhoy calculator endpoint.

    Args:
        client: Optional pre-configured OptionsAhoyClient. A default keyless client
            pointing at https://optionsahoy.com is used when omitted.

    Returns:
        A list of CrewAI BaseTools, each with a name, description, and pydantic
        args_schema mirroring the underlying endpoint.
    """
    oa = client or OptionsAhoyClient()
    return [tool_cls(client=oa) for tool_cls in _TOOL_CLASSES]
