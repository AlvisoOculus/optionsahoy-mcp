# AlphaLatitude Inc. (c) 2026
"""Tool registry mapping equity-compensation questions to OptionsAhoy calculators.

Each entry pairs an OpenAI function-calling schema (so a language model can extract
the structured inputs from a natural-language question) with the name of the
``OptionsAhoyClient`` method that computes the answer. The agent never reimplements
the math: it forwards the extracted arguments to the keyless OptionsAhoy REST API
through the client and streams the parsed result back.

What each tool computes (not how):

- amt_iso: the multi-year incentive stock option (ISO) exercise schedule that
  minimizes lifetime cost under the alternative minimum tax (AMT).
- nso: the tax and after-tax proceeds of exercising non-qualified stock options
  (NSOs) and holding versus selling.
- rsu_sell_vs_hold: selling vested restricted stock units (RSUs) at vest versus
  holding, compared on an after-tax, risk-adjusted basis.
- concentration: the after-tax cost of diversifying a concentrated single-stock
  position.
- protective_put: the price of three hedge structures (a protective put, a
  zero-cost collar, and a put spread) at a chosen downside protection level and
  tenor.
- qsbs: qualified small business stock (QSBS) eligibility and the resulting
  federal and state capital-gains exclusion.
- equity_funding: which equity lots to sell, and when, to fund a cash goal by a
  target date at the least after-tax cost.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from optionsahoy import OptionsAhoyClient

# Shared enum-ish fields reused across several schemas.
_FILING_STATUS = {
    "type": "string",
    "description": "Tax filing status.",
    "enum": ["single", "married-joint", "married-separate", "head-of-household"],
}
_STATE_CODE = {
    "type": "string",
    "description": "Two-letter state code of tax residence, for example 'CA' or 'NY'.",
}


def _method(client: OptionsAhoyClient, name: str) -> Callable[..., Dict[str, Any]]:
    """Return the bound ``OptionsAhoyClient`` method for a registered tool name."""
    return getattr(client, name)


# Ordered registry. ``parameters`` is a JSON Schema object passed verbatim to the
# language model as an OpenAI function-calling tool definition. ``required`` lists
# only the fields the OptionsAhoy endpoint cannot default; optional modelling
# assumptions (growth, volatility) are left for the API to fill in.
TOOLS: List[Dict[str, Any]] = [
    {
        "name": "amt_iso",
        "description": (
            "Optimize a multi-year incentive stock option (ISO) exercise schedule "
            "under the alternative minimum tax (AMT)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "shares": {"type": "integer", "description": "Number of ISO shares."},
                "strike": {"type": "number", "description": "Per-share strike price."},
                "fmv": {"type": "number", "description": "Current fair market value per share."},
                "filingStatus": _FILING_STATUS,
                "ordinaryIncome": {"type": "number", "description": "Annual ordinary income."},
                "stateCode": _STATE_CODE,
                "carryforwardCredit": {
                    "type": "number",
                    "description": "Existing AMT credit carryforward, or 0.",
                },
                "horizon": {"type": "integer", "description": "Planning horizon in years."},
                "cashReturnRate": {
                    "type": "number",
                    "description": "Assumed annual return on cash, as a decimal such as 0.04.",
                },
                "grantDate": {"type": "string", "description": "ISO grant date, YYYY-MM-DD."},
                "hasLeftCompany": {
                    "type": "boolean",
                    "description": "Whether the holder has left the company.",
                },
                "terminationDate": {
                    "type": ["string", "null"],
                    "description": "Termination date YYYY-MM-DD, or null if still employed.",
                },
            },
            "required": [
                "shares",
                "strike",
                "fmv",
                "filingStatus",
                "ordinaryIncome",
                "stateCode",
                "carryforwardCredit",
                "horizon",
                "cashReturnRate",
                "grantDate",
                "hasLeftCompany",
                "terminationDate",
            ],
        },
    },
    {
        "name": "nso",
        "description": (
            "Compute the tax and after-tax proceeds of exercising non-qualified stock "
            "options (NSOs) and holding versus selling."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "shares": {"type": "integer", "description": "Number of NSO shares."},
                "strike": {"type": "number", "description": "Per-share strike price."},
                "currentPrice": {"type": "number", "description": "Current share price."},
                "ordinaryIncome": {"type": "number", "description": "Annual ordinary income."},
                "filingStatus": _FILING_STATUS,
                "stateCode": _STATE_CODE,
                "stillEmployed": {
                    "type": "boolean",
                    "description": "Whether the holder is still employed.",
                },
                "holdYears": {
                    "type": "number",
                    "description": "Years to hold after exercise before selling.",
                },
                "holdFunding": {
                    "type": "string",
                    "description": "How the exercise cost is funded.",
                    "enum": ["cash", "cashless", "sell-to-cover"],
                },
            },
            "required": [
                "shares",
                "strike",
                "currentPrice",
                "ordinaryIncome",
                "filingStatus",
                "stateCode",
                "stillEmployed",
                "holdYears",
                "holdFunding",
            ],
        },
    },
    {
        "name": "rsu_sell_vs_hold",
        "description": (
            "Compare selling vested restricted stock units (RSUs) at vest against "
            "holding them, on an after-tax, risk-adjusted basis."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "shares": {"type": "integer", "description": "Number of vested RSU shares."},
                "currentPrice": {"type": "number", "description": "Current share price."},
                "ordinaryIncome": {"type": "number", "description": "Annual ordinary income."},
                "filingStatus": _FILING_STATUS,
                "stateCode": _STATE_CODE,
                "stillEmployed": {
                    "type": "boolean",
                    "description": "Whether the holder is still employed.",
                },
                "holdYears": {
                    "type": "number",
                    "description": "Years to hold the shares before selling.",
                },
            },
            "required": [
                "shares",
                "currentPrice",
                "ordinaryIncome",
                "filingStatus",
                "stateCode",
                "stillEmployed",
                "holdYears",
            ],
        },
    },
    {
        "name": "concentration",
        "description": (
            "Analyze a concentrated single-stock position and the after-tax cost of "
            "diversifying it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "positionValue": {"type": "number", "description": "Current market value of the position."},
                "costBasis": {"type": "number", "description": "Total cost basis of the position."},
                "acquisitionDate": {"type": "string", "description": "Acquisition date, YYYY-MM-DD."},
                "sector": {"type": "string", "description": "Sector of the holding, for example 'tech'."},
                "stateCode": _STATE_CODE,
                "filingStatus": _FILING_STATUS,
                "ordinaryIncome": {"type": "number", "description": "Annual ordinary income."},
                "totalAssets": {
                    "type": "number",
                    "description": "Total investable assets, to size the concentration.",
                },
            },
            "required": [
                "positionValue",
                "costBasis",
                "acquisitionDate",
                "sector",
                "stateCode",
                "filingStatus",
                "ordinaryIncome",
                "totalAssets",
            ],
        },
    },
    {
        "name": "protective_put",
        "description": (
            "Price a protective put, a zero-cost collar, and a put spread for a stock "
            "position at a given downside protection level and tenor."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "positionValue": {"type": "number", "description": "Market value of the position to hedge."},
                "sector": {"type": "string", "description": "Sector of the holding, for example 'tech'."},
                "protectionLevel": {
                    "type": "number",
                    "description": "Floor as a fraction of current value, for example 0.9 for a 10 percent floor.",
                },
                "tenorYears": {"type": "number", "description": "Hedge tenor in years."},
                "spreadRiskLevel": {
                    "type": "number",
                    "minimum": 0.01,
                    "maximum": 0.2,
                    "description": (
                        "Put spread floor breach risk: probability the stock ends "
                        "below the spread's short strike (presets 0.20 / 0.10 / 0.05 "
                        "/ 0.01, i.e. 1 in 5 / 10 / 20 / 100; off-preset snaps to "
                        "nearest). Affects only the putSpread block. Default 0.10."
                    ),
                },
            },
            "required": ["positionValue", "sector", "protectionLevel", "tenorYears"],
        },
    },
    {
        "name": "qsbs",
        "description": (
            "Check qualified small business stock (QSBS) eligibility and the resulting "
            "federal and state capital-gains exclusion."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "acquisitionDate": {"type": "string", "description": "Share acquisition date, YYYY-MM-DD."},
                "saleDate": {"type": "string", "description": "Planned or actual sale date, YYYY-MM-DD."},
                "entityType": {"type": "string", "description": "Issuer entity type, for example 'us-c-corp'."},
                "acquisitionMethod": {
                    "type": "string",
                    "description": "How the stock was acquired, for example 'original-issuance'.",
                },
                "assetCategory": {
                    "type": "string",
                    "description": "Gross-asset category at issuance, for example 'under-50m'.",
                },
                "industry": {"type": "string", "description": "Issuer industry, for example 'tech-software'."},
                "activeBusiness": {
                    "type": "string",
                    "description": "Whether the issuer met the active-business test, 'yes' or 'no'.",
                },
                "adjustedBasis": {"type": "number", "description": "Adjusted cost basis of the stock."},
                "expectedGain": {"type": "number", "description": "Expected gain on sale."},
                "stateCode": _STATE_CODE,
                "ordinaryIncome": {"type": "number", "description": "Annual ordinary income."},
                "filingStatus": _FILING_STATUS,
            },
            "required": [
                "acquisitionDate",
                "saleDate",
                "entityType",
                "acquisitionMethod",
                "assetCategory",
                "industry",
                "activeBusiness",
                "adjustedBasis",
                "expectedGain",
                "stateCode",
                "ordinaryIncome",
                "filingStatus",
            ],
        },
    },
    {
        "name": "equity_funding",
        "description": (
            "Plan which equity lots to sell, and when, to fund a cash goal by a target "
            "date with the least after-tax cost."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "targetAfterTax": {
                    "type": "number",
                    "description": "After-tax cash amount needed.",
                },
                "targetDate": {"type": "string", "description": "Date the cash is needed by, YYYY-MM-DD."},
                "ordinaryIncome": {"type": "number", "description": "Annual ordinary income."},
                "filingStatus": _FILING_STATUS,
                "stateCode": _STATE_CODE,
                "currentPrice": {
                    "type": "number",
                    "description": "Current share price, when using the simple single-position form.",
                },
            },
            "required": [
                "targetAfterTax",
                "targetDate",
                "ordinaryIncome",
                "filingStatus",
                "stateCode",
            ],
        },
    },
]

# Fast lookup by tool name.
TOOLS_BY_NAME: Dict[str, Dict[str, Any]] = {tool["name"]: tool for tool in TOOLS}


def openai_tool_specs() -> List[Dict[str, Any]]:
    """Return the registry as OpenAI ``tools`` (function-calling) specifications."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
        }
        for tool in TOOLS
    ]


def call_tool(
    client: OptionsAhoyClient, name: str, arguments: Dict[str, Any]
) -> Dict[str, Any]:
    """Dispatch ``name`` to the matching ``OptionsAhoyClient`` method.

    Raises ``KeyError`` for an unknown tool name. Arguments are forwarded as
    keyword arguments; the client validates and posts them to the keyless API.
    """
    if name not in TOOLS_BY_NAME:
        raise KeyError(f"Unknown OptionsAhoy tool: {name}")
    return _method(client, name)(**arguments)
