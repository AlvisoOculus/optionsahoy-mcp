"""HTTP client for the OptionsAhoy keyless public REST API.

Every endpoint is an unauthenticated POST (except the discovery/stats GETs, which
this client does not wrap). Field names, types, and required-ness mirror the
published OpenAPI schema at https://optionsahoy.com/openapi.json one for one; this
client does not invent or rename fields.

No API key is read, stored, or sent anywhere.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

DEFAULT_BASE_URL = "https://optionsahoy.com"
DEFAULT_TIMEOUT = 30.0


class OptionsAhoyError(Exception):
    """Raised when the OptionsAhoy API returns an HTTP error or an unusable response.

    Attributes:
        status_code: HTTP status code, when one is available.
        payload: Parsed error body (typically ``{"error": "..."}``), when available.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        payload: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


def _drop_none(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Strip keys whose value is None so optional, unset fields are not posted.

    ``terminationDate`` is intentionally kept even when None: the AMT/ISO schema
    requires it and treats null as a meaningful "no termination" value.
    """
    keep_null = {"terminationDate"}
    return {k: v for k, v in payload.items() if v is not None or k in keep_null}


class OptionsAhoyClient:
    """Synchronous client wrapping the OptionsAhoy calculator endpoints.

    Example:
        >>> client = OptionsAhoyClient()
        >>> result = client.qsbs(
        ...     acquisitionDate="2018-01-01",
        ...     saleDate="2026-02-01",
        ...     entityType="us-c-corp",
        ...     acquisitionMethod="original-issuance",
        ...     assetCategory="under-50m",
        ...     industry="tech-software",
        ...     activeBusiness="yes",
        ...     adjustedBasis=10000,
        ...     expectedGain=2000000,
        ...     stateCode="CA",
        ...     ordinaryIncome=250000,
        ...     filingStatus="single",
        ... )
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._client = client or httpx.Client(timeout=timeout)

    def __enter__(self) -> "OptionsAhoyClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # -- transport ---------------------------------------------------------

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        body = _drop_none(payload)
        try:
            response = self._client.post(url, json=body)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail: Any = None
            try:
                detail = exc.response.json()
            except Exception:  # noqa: BLE001 - body may not be JSON
                detail = exc.response.text
            message = f"OptionsAhoy request to {path} failed ({exc.response.status_code})"
            if isinstance(detail, dict) and detail.get("error"):
                message = f"{message}: {detail['error']}"
            raise OptionsAhoyError(
                message, status_code=exc.response.status_code, payload=detail
            ) from exc
        except httpx.HTTPError as exc:
            raise OptionsAhoyError(f"OptionsAhoy request to {path} failed: {exc}") from exc

        try:
            return response.json()
        except ValueError as exc:
            raise OptionsAhoyError(
                f"OptionsAhoy response from {path} was not valid JSON"
            ) from exc

    # -- endpoints ---------------------------------------------------------

    def amt_iso(
        self,
        *,
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
        alternative minimum tax (AMT)."""
        return self._post(
            "/api/v1/amt-iso",
            {
                "shares": shares,
                "strike": strike,
                "fmv": fmv,
                "filingStatus": filingStatus,
                "ordinaryIncome": ordinaryIncome,
                "stateCode": stateCode,
                "carryforwardCredit": carryforwardCredit,
                "horizon": horizon,
                "cashReturnRate": cashReturnRate,
                "grantDate": grantDate,
                "hasLeftCompany": hasLeftCompany,
                "terminationDate": terminationDate,
                "expectedGrowth": expectedGrowth,
                "ticker": ticker,
                "volatilityDrag": volatilityDrag,
                "volatility": volatility,
            },
        )

    def nso(
        self,
        *,
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
        """Compute the tax and after-tax proceeds of exercising non-qualified stock
        options (NSOs) and holding versus selling."""
        return self._post(
            "/api/v1/nso",
            {
                "shares": shares,
                "strike": strike,
                "currentPrice": currentPrice,
                "ordinaryIncome": ordinaryIncome,
                "filingStatus": filingStatus,
                "stateCode": stateCode,
                "stillEmployed": stillEmployed,
                "holdYears": holdYears,
                "holdFunding": holdFunding,
                "expectedSalePrice": expectedSalePrice,
                "haircut": haircut,
                "volatility": volatility,
                "expectedMarketReturn": expectedMarketReturn,
                "ticker": ticker,
            },
        )

    def rsu_sell_vs_hold(
        self,
        *,
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
        them, on an after-tax, risk-adjusted basis."""
        return self._post(
            "/api/v1/rsu-sell-vs-hold",
            {
                "shares": shares,
                "currentPrice": currentPrice,
                "ordinaryIncome": ordinaryIncome,
                "filingStatus": filingStatus,
                "stateCode": stateCode,
                "stillEmployed": stillEmployed,
                "holdYears": holdYears,
                "expectedSalePrice": expectedSalePrice,
                "haircut": haircut,
                "volatility": volatility,
                "expectedMarketReturn": expectedMarketReturn,
                "ticker": ticker,
            },
        )

    def concentration(
        self,
        *,
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
        """Analyze a concentrated single-stock position and the after-tax cost of
        diversifying it."""
        return self._post(
            "/api/v1/concentration",
            {
                "positionValue": positionValue,
                "costBasis": costBasis,
                "acquisitionDate": acquisitionDate,
                "sector": sector,
                "stateCode": stateCode,
                "filingStatus": filingStatus,
                "ordinaryIncome": ordinaryIncome,
                "totalAssets": totalAssets,
                "expectedPositionReturn": expectedPositionReturn,
                "expectedMarketReturn": expectedMarketReturn,
                "ticker": ticker,
                "volatilityDrag": volatilityDrag,
                "volatility": volatility,
                "hedgeChoice": hedgeChoice,
            },
        )

    def protective_put(
        self,
        *,
        positionValue: float,
        sector: str,
        protectionLevel: float,
        tenorYears: float,
        volatility: Optional[float] = None,
        expectedReturn: Optional[float] = None,
        tickerLabel: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Price a protective put hedge for a stock position at a given downside
        protection level and tenor."""
        return self._post(
            "/api/v1/protective-put",
            {
                "positionValue": positionValue,
                "sector": sector,
                "protectionLevel": protectionLevel,
                "tenorYears": tenorYears,
                "volatility": volatility,
                "expectedReturn": expectedReturn,
                "tickerLabel": tickerLabel,
            },
        )

    def qsbs(
        self,
        *,
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
        """Check qualified small business stock (QSBS) eligibility and the resulting
        federal and state capital-gains exclusion."""
        return self._post(
            "/api/v1/qsbs",
            {
                "acquisitionDate": acquisitionDate,
                "saleDate": saleDate,
                "entityType": entityType,
                "acquisitionMethod": acquisitionMethod,
                "assetCategory": assetCategory,
                "industry": industry,
                "activeBusiness": activeBusiness,
                "adjustedBasis": adjustedBasis,
                "expectedGain": expectedGain,
                "stateCode": stateCode,
                "ordinaryIncome": ordinaryIncome,
                "filingStatus": filingStatus,
            },
        )

    def equity_funding(
        self,
        *,
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
        today: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Plan which equity lots to sell, and when, to fund a cash goal by a target date
        with the least after-tax cost. Provide ``stacks`` (preferred) or the legacy
        ``lots`` plus ``currentPrice``."""
        return self._post(
            "/api/v1/equity-funding",
            {
                "targetAfterTax": targetAfterTax,
                "targetDate": targetDate,
                "ordinaryIncome": ordinaryIncome,
                "filingStatus": filingStatus,
                "stateCode": stateCode,
                "stacks": stacks,
                "lots": lots,
                "currentPrice": currentPrice,
                "expectedAnnualGrowth": expectedAnnualGrowth,
                "cashInterestRate": cashInterestRate,
                "riskToleranceShortfall": riskToleranceShortfall,
                "defaultVolatility": defaultVolatility,
                "today": today,
            },
        )
