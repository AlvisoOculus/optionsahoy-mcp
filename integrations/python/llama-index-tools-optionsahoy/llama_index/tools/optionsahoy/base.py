"""LlamaIndex ``BaseToolSpec`` for the OptionsAhoy calculators.

One spec function per public endpoint. Each function wraps a method on the keyless
``optionsahoy`` client; its type hints and docstring mirror the endpoint's required and
optional fields exactly as published in the OpenAPI schema at
https://optionsahoy.com/openapi.json. LlamaIndex derives each tool's name, description,
and argument schema from the function signature and docstring. Tool descriptions say
what each tool computes, not how, and deabbreviate acronyms on first use.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from llama_index.core.tools.tool_spec.base import BaseToolSpec
from optionsahoy import OptionsAhoyClient


class OptionsAhoyToolSpec(BaseToolSpec):
    """LlamaIndex tool spec exposing the seven OptionsAhoy calculator endpoints.

    Use ``to_tool_list()`` to get one LlamaIndex ``FunctionTool`` per endpoint, ready to
    hand to an agent. No application programming interface (API) key is required.

    Example:
        >>> spec = OptionsAhoyToolSpec()
        >>> tools = spec.to_tool_list()
        >>> # agent = ReActAgent.from_tools(tools, llm=...)
    """

    spec_functions = [
        "amt_iso_optimize",
        "nso_calculate",
        "rsu_sell_vs_hold",
        "concentration_analyze",
        "protective_put_price",
        "qsbs_check",
        "equity_funding_plan",
    ]

    def __init__(self, client: Optional[OptionsAhoyClient] = None) -> None:
        """Create the tool spec.

        Args:
            client: Optional pre-configured ``OptionsAhoyClient``. A default keyless
                client pointing at https://optionsahoy.com is used when omitted.
        """
        self._client = client or OptionsAhoyClient()

    def amt_iso_optimize(
        self,
        shares: int,
        strike: float,
        fmv: float,
        filingStatus: str,
        ordinaryIncome: float,
        stateCode: str,
        carryforwardCredit: float,
        horizon: int,
        cashReturnRate: float,
        grantDate: str,
        hasLeftCompany: bool,
        terminationDate: Optional[str],
        expectedGrowth: Optional[float] = None,
        ticker: Optional[str] = None,
        volatilityDrag: Optional[float] = None,
        volatility: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Optimize a multi-year incentive stock option (ISO) exercise schedule under the
        alternative minimum tax (AMT). Returns the after-tax-optimal number of shares to
        exercise each year across the planning horizon, with the federal and state tax for
        each path.

        Args:
            shares: Number of ISO shares available to exercise.
            strike: Exercise (strike) price per share.
            fmv: Current fair market value per share.
            filingStatus: Tax filing status (single, married_joint, head_household).
            ordinaryIncome: Annual ordinary income before this exercise.
            stateCode: Two-letter US state code, or DC.
            carryforwardCredit: Existing AMT credit carryforward.
            horizon: Planning horizon in years (1 to 10).
            cashReturnRate: Annual return on cash held instead of exercising.
            grantDate: ISO grant date, ISO-8601 (YYYY-MM-DD).
            hasLeftCompany: Whether the holder has left the company.
            terminationDate: Termination date (YYYY-MM-DD), or null if still employed.
            expectedGrowth: Expected annual share-price growth.
            ticker: Public ticker to source expected return from.
            volatilityDrag: Volatility drag factor (0 to 0.99).
            volatility: Annualized volatility of the stock.
        """
        return self._client.amt_iso(
            shares=shares,
            strike=strike,
            fmv=fmv,
            filingStatus=filingStatus,
            ordinaryIncome=ordinaryIncome,
            stateCode=stateCode,
            carryforwardCredit=carryforwardCredit,
            horizon=horizon,
            cashReturnRate=cashReturnRate,
            grantDate=grantDate,
            hasLeftCompany=hasLeftCompany,
            terminationDate=terminationDate,
            expectedGrowth=expectedGrowth,
            ticker=ticker,
            volatilityDrag=volatilityDrag,
            volatility=volatility,
        )

    def nso_calculate(
        self,
        shares: int,
        strike: float,
        currentPrice: float,
        ordinaryIncome: float,
        filingStatus: str,
        stateCode: str,
        stillEmployed: bool,
        holdYears: float,
        holdFunding: str,
        expectedSalePrice: Optional[float] = None,
        haircut: Optional[float] = None,
        volatility: Optional[float] = None,
        expectedMarketReturn: Optional[float] = None,
        ticker: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Calculate the tax and after-tax proceeds of exercising non-qualified stock
        options (NSOs) and holding versus selling, including ordinary-income tax at
        exercise and capital-gains treatment on later sale.

        Args:
            shares: Number of NSO shares to exercise.
            strike: Exercise (strike) price per share.
            currentPrice: Current share price.
            ordinaryIncome: Annual ordinary income before this exercise.
            filingStatus: Tax filing status (single, married_joint, head_household).
            stateCode: Two-letter US state code, or DC.
            stillEmployed: Whether the holder is still employed.
            holdYears: Years the shares are held after exercise.
            holdFunding: How the exercise is funded (sell-to-cover or cash).
            expectedSalePrice: Expected sale price per share.
            haircut: Risk haircut on expected upside (0 to 1).
            volatility: Annualized volatility of the stock.
            expectedMarketReturn: Expected broad-market annual return.
            ticker: Public ticker to source expected return from.
        """
        return self._client.nso(
            shares=shares,
            strike=strike,
            currentPrice=currentPrice,
            ordinaryIncome=ordinaryIncome,
            filingStatus=filingStatus,
            stateCode=stateCode,
            stillEmployed=stillEmployed,
            holdYears=holdYears,
            holdFunding=holdFunding,
            expectedSalePrice=expectedSalePrice,
            haircut=haircut,
            volatility=volatility,
            expectedMarketReturn=expectedMarketReturn,
            ticker=ticker,
        )

    def rsu_sell_vs_hold(
        self,
        shares: int,
        currentPrice: float,
        ordinaryIncome: float,
        filingStatus: str,
        stateCode: str,
        stillEmployed: bool,
        holdYears: float,
        expectedSalePrice: Optional[float] = None,
        haircut: Optional[float] = None,
        volatility: Optional[float] = None,
        expectedMarketReturn: Optional[float] = None,
        ticker: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Compare selling vested restricted stock units (RSUs) at vest against holding
        them, on an after-tax, risk-adjusted basis, and return which choice is expected to
        leave more wealth.

        Args:
            shares: Number of vested RSU shares.
            currentPrice: Current share price.
            ordinaryIncome: Annual ordinary income.
            filingStatus: Tax filing status (single, married_joint, head_household).
            stateCode: Two-letter US state code, or DC.
            stillEmployed: Whether the holder is still employed.
            holdYears: Years to hold (0.25 to 5).
            expectedSalePrice: Expected sale price per share.
            haircut: Risk haircut on expected upside (0 to 1).
            volatility: Annualized volatility of the stock.
            expectedMarketReturn: Expected broad-market annual return.
            ticker: Public ticker to source expected return from.
        """
        return self._client.rsu_sell_vs_hold(
            shares=shares,
            currentPrice=currentPrice,
            ordinaryIncome=ordinaryIncome,
            filingStatus=filingStatus,
            stateCode=stateCode,
            stillEmployed=stillEmployed,
            holdYears=holdYears,
            expectedSalePrice=expectedSalePrice,
            haircut=haircut,
            volatility=volatility,
            expectedMarketReturn=expectedMarketReturn,
            ticker=ticker,
        )

    def concentration_analyze(
        self,
        positionValue: float,
        costBasis: float,
        acquisitionDate: str,
        sector: str,
        stateCode: str,
        filingStatus: str,
        ordinaryIncome: float,
        totalAssets: float,
        expectedPositionReturn: Optional[float] = None,
        expectedMarketReturn: Optional[float] = None,
        ticker: Optional[str] = None,
        volatilityDrag: Optional[float] = None,
        volatility: Optional[float] = None,
        hedgeChoice: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Analyze a concentrated single-stock position: its share of total assets, the
        after-tax cost of diversifying, and the risk reduction from selling down or
        hedging.

        Args:
            positionValue: Current market value of the position.
            costBasis: Total cost basis of the position.
            acquisitionDate: Acquisition date, ISO-8601 (YYYY-MM-DD).
            sector: Sector of the concentrated stock.
            stateCode: Two-letter US state code, or DC.
            filingStatus: Tax filing status (single, married_joint, head_household).
            ordinaryIncome: Annual ordinary income.
            totalAssets: Total investable assets including this position.
            expectedPositionReturn: Expected annual return of the position.
            expectedMarketReturn: Expected broad-market annual return.
            ticker: Public ticker to source expected return from.
            volatilityDrag: Volatility drag factor (0 to 0.99).
            volatility: Annualized volatility of the stock.
            hedgeChoice: Optional hedge to evaluate, with keys kind, protectionLevel,
                tenorYears, upsideCapPct.
        """
        return self._client.concentration(
            positionValue=positionValue,
            costBasis=costBasis,
            acquisitionDate=acquisitionDate,
            sector=sector,
            stateCode=stateCode,
            filingStatus=filingStatus,
            ordinaryIncome=ordinaryIncome,
            totalAssets=totalAssets,
            expectedPositionReturn=expectedPositionReturn,
            expectedMarketReturn=expectedMarketReturn,
            ticker=ticker,
            volatilityDrag=volatilityDrag,
            volatility=volatility,
            hedgeChoice=hedgeChoice,
        )

    def protective_put_price(
        self,
        positionValue: float,
        sector: str,
        protectionLevel: float,
        tenorYears: float,
        volatility: Optional[float] = None,
        expectedReturn: Optional[float] = None,
        ticker: Optional[str] = None,
        tickerLabel: Optional[str] = None,
        spreadRiskLevel: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Price downside hedges for a stock position at a chosen protection level and
        tenor, returning the estimated premium and net cost of each structure (protective
        put, zero-cost collar, and put spread) and which one is recommended.

        Args:
            positionValue: Market value of the position to hedge.
            sector: Sector of the stock being hedged.
            protectionLevel: Downside protected, as a fraction (0.05 to 0.5).
            tenorYears: Hedge tenor in years.
            volatility: Annualized volatility of the stock.
            expectedReturn: Expected annual return of the stock.
            ticker: Public ticker to source implied volatility from.
            tickerLabel: Display label for the ticker.
            spreadRiskLevel: Put spread floor breach risk - probability the stock ends
                below the spread's short strike (presets 0.20 / 0.10 / 0.05 / 0.01, i.e.
                1 in 5 / 10 / 20 / 100; off-preset snaps to the nearest). Affects only the
                putSpread block. Default 0.10.
        """
        return self._client.protective_put(
            positionValue=positionValue,
            sector=sector,
            protectionLevel=protectionLevel,
            tenorYears=tenorYears,
            volatility=volatility,
            expectedReturn=expectedReturn,
            ticker=ticker,
            tickerLabel=tickerLabel,
            spreadRiskLevel=spreadRiskLevel,
        )

    def qsbs_check(
        self,
        acquisitionDate: str,
        saleDate: str,
        entityType: str,
        acquisitionMethod: str,
        assetCategory: str,
        industry: str,
        activeBusiness: str,
        adjustedBasis: float,
        expectedGain: float,
        stateCode: str,
        ordinaryIncome: float,
        filingStatus: str,
    ) -> Dict[str, Any]:
        """Check qualified small business stock (QSBS) eligibility and compute the
        resulting federal and state capital-gains exclusion on a planned sale.

        Args:
            acquisitionDate: Stock acquisition date (YYYY-MM-DD).
            saleDate: Planned sale date (YYYY-MM-DD).
            entityType: Issuer entity type (us-c-corp or other).
            acquisitionMethod: How the stock was acquired (original-issuance,
                gift-or-inheritance, secondary, unsure).
            assetCategory: Issuer gross assets at issuance (under-50m, 50m-to-75m,
                over-75m, unsure).
            industry: Issuer industry.
            activeBusiness: Whether the issuer meets the active-business requirement
                (yes, no, unsure).
            adjustedBasis: Adjusted basis in the stock.
            expectedGain: Expected gain on sale.
            stateCode: Two-letter US state code, or DC.
            ordinaryIncome: Annual ordinary income.
            filingStatus: Tax filing status (single, married_joint, head_household).
        """
        return self._client.qsbs(
            acquisitionDate=acquisitionDate,
            saleDate=saleDate,
            entityType=entityType,
            acquisitionMethod=acquisitionMethod,
            assetCategory=assetCategory,
            industry=industry,
            activeBusiness=activeBusiness,
            adjustedBasis=adjustedBasis,
            expectedGain=expectedGain,
            stateCode=stateCode,
            ordinaryIncome=ordinaryIncome,
            filingStatus=filingStatus,
        )

    def equity_funding_plan(
        self,
        targetAfterTax: float,
        targetDate: str,
        ordinaryIncome: float,
        filingStatus: str,
        stateCode: str,
        stacks: Optional[List[Dict[str, Any]]] = None,
        lots: Optional[List[Dict[str, Any]]] = None,
        currentPrice: Optional[float] = None,
        expectedAnnualGrowth: Optional[float] = None,
        cashInterestRate: Optional[float] = None,
        riskToleranceShortfall: Optional[float] = None,
        defaultVolatility: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Plan which equity lots to sell, and when, to fund a cash goal by a target date
        with the least after-tax cost, accounting for holding-period thresholds and
        shortfall risk. Provide ``stacks`` (preferred) or the legacy ``lots`` plus
        ``currentPrice``.

        Args:
            targetAfterTax: After-tax cash goal to raise.
            targetDate: Date the cash is needed (YYYY-MM-DD).
            ordinaryIncome: Annual ordinary income.
            filingStatus: Tax filing status (single, married_joint, head_household).
            stateCode: Two-letter US state code, or DC.
            stacks: Preferred. List of stacks, each with currentPrice and a lots list;
                optional ticker, expectedAnnualGrowth, volatility per stack. Each lot has
                shares, costBasisPerShare, acquisitionDate, and optional vestDate.
            lots: Legacy single-stack lots list (use with currentPrice).
            currentPrice: Legacy single-stack current price.
            expectedAnnualGrowth: Expected annual share-price growth.
            cashInterestRate: Annual interest rate on idle cash.
            riskToleranceShortfall: Acceptable probability of shortfall (0 to 1).
            defaultVolatility: Default annualized volatility.
        """
        return self._client.equity_funding(
            targetAfterTax=targetAfterTax,
            targetDate=targetDate,
            ordinaryIncome=ordinaryIncome,
            filingStatus=filingStatus,
            stateCode=stateCode,
            stacks=stacks,
            lots=lots,
            currentPrice=currentPrice,
            expectedAnnualGrowth=expectedAnnualGrowth,
            cashInterestRate=cashInterestRate,
            riskToleranceShortfall=riskToleranceShortfall,
            defaultVolatility=defaultVolatility,
        )
