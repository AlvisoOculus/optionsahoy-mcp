# AlphaLatitude Inc. © 2026
"""Tests for the OpenAI Agents SDK OptionsAhoy tools.

The OptionsAhoy client is mocked so no network call is made; tests assert tool
shape (name, description, params_json_schema) and that invoking a tool routes
through the correct client method with the right keyword arguments.
"""

import asyncio
import json

import pytest
from agents import FunctionTool

from optionsahoy_openai_agents import get_optionsahoy_tools

EXPECTED_NAMES = {
    "optionsahoy_amt_iso_optimize",
    "optionsahoy_nso_calculate",
    "optionsahoy_rsu_sell_vs_hold",
    "optionsahoy_concentration_analyze",
    "optionsahoy_protective_put_price",
    "optionsahoy_qsbs_check",
    "optionsahoy_equity_funding_plan",
    "optionsahoy_rsu_lot_optimize",
}

# Tool name -> (client method name mocked on the fake client)
NAME_TO_METHOD = {
    "optionsahoy_amt_iso_optimize": "amt_iso",
    "optionsahoy_nso_calculate": "nso",
    "optionsahoy_rsu_sell_vs_hold": "rsu_sell_vs_hold",
    "optionsahoy_concentration_analyze": "concentration",
    "optionsahoy_protective_put_price": "protective_put",
    "optionsahoy_qsbs_check": "qsbs",
    "optionsahoy_equity_funding_plan": "equity_funding",
    "optionsahoy_rsu_lot_optimize": "rsu_lot_order",
}


class _FakeClient:
    """Records the last call for each endpoint method without hitting the network."""

    def __init__(self):
        self.calls = {}
        for method in NAME_TO_METHOD.values():
            self._install(method)

    def _install(self, method):
        def _fn(**kwargs):
            self.calls[method] = kwargs
            return {"ok": True, "method": method}

        setattr(self, method, _fn)


def _invoke(tool, payload):
    return asyncio.run(tool.on_invoke_tool(None, json.dumps(payload)))


def test_returns_all_tools():
    tools = get_optionsahoy_tools()
    assert len(tools) == 8
    assert {t.name for t in tools} == EXPECTED_NAMES


def test_each_tool_shape():
    for tool in get_optionsahoy_tools():
        assert isinstance(tool, FunctionTool)
        assert tool.name
        assert tool.description and len(tool.description) > 20
        assert tool.params_json_schema.get("type") == "object"
        assert tool.params_json_schema.get("properties")
        # optional forward-looking fields mean the schema is intentionally non-strict
        assert tool.strict_json_schema is False


def test_descriptions_have_no_banned_characters():
    for tool in get_optionsahoy_tools():
        assert "—" not in tool.description  # em-dash
        assert "$" not in tool.description


def test_schema_mirrors_required_fields():
    by_name = {t.name: t for t in get_optionsahoy_tools()}
    schema = by_name["optionsahoy_qsbs_check"].params_json_schema
    required = set(schema.get("required", []))
    for field in ("acquisitionDate", "saleDate", "entityType", "expectedGain"):
        assert field in schema["properties"]
        assert field in required


# One minimal, schema-valid payload per tool. Only required fields are set;
# model_dump() then forwards required + optional (as None) to the fake client.
MINIMAL_PAYLOADS = {
    "optionsahoy_amt_iso_optimize": {
        "shares": 1000,
        "strike": 2.0,
        "fmv": 20.0,
        "filingStatus": "single",
        "ordinaryIncome": 200000,
        "stateCode": "CA",
        "carryforwardCredit": 0,
        "horizon": 3,
        "cashReturnRate": 0.04,
        "grantDate": "2022-01-01",
        "hasLeftCompany": False,
        "terminationDate": None,
    },
    "optionsahoy_nso_calculate": {
        "shares": 1000,
        "strike": 2.0,
        "currentPrice": 20.0,
        "ordinaryIncome": 200000,
        "filingStatus": "single",
        "stateCode": "CA",
        "stillEmployed": True,
        "holdYears": 2,
        "holdFunding": "cash",
    },
    "optionsahoy_rsu_sell_vs_hold": {
        "shares": 1000,
        "currentPrice": 20.0,
        "ordinaryIncome": 200000,
        "filingStatus": "single",
        "stateCode": "CA",
        "stillEmployed": True,
        "holdYears": 2,
    },
    "optionsahoy_concentration_analyze": {
        "positionValue": 500000,
        "costBasis": 50000,
        "acquisitionDate": "2020-01-01",
        "sector": "tech_software",
        "stateCode": "CA",
        "filingStatus": "single",
        "ordinaryIncome": 200000,
        "totalAssets": 800000,
    },
    "optionsahoy_protective_put_price": {
        "positionValue": 500000,
        "sector": "tech_software",
        "protectionLevel": 0.1,
        "tenorYears": 1,
    },
    "optionsahoy_qsbs_check": {
        "acquisitionDate": "2018-01-01",
        "saleDate": "2026-02-01",
        "entityType": "us-c-corp",
        "acquisitionMethod": "original-issuance",
        "assetCategory": "under-50m",
        "industry": "tech-software",
        "activeBusiness": "yes",
        "adjustedBasis": 10000,
        "expectedGain": 2000000,
        "stateCode": "CA",
        "ordinaryIncome": 250000,
        "filingStatus": "single",
    },
    "optionsahoy_equity_funding_plan": {
        "targetAfterTax": 100000,
        "targetDate": "2027-01-01",
        "ordinaryIncome": 200000,
        "filingStatus": "single",
        "stateCode": "CA",
    },
    "optionsahoy_rsu_lot_optimize": {
        "lots": [
            {"vestDate": "2022-08-15", "shares": 120, "costBasisPerShare": 95},
            {"vestDate": "2024-02-15", "shares": 100, "costBasisPerShare": 130},
            {"vestDate": "2026-05-15", "shares": 80, "costBasisPerShare": 210},
        ],
        "currentPrice": 180,
        "divestFraction": 0.5,
        "horizonYears": 2,
        "ordinaryIncome": 200000,
        "filingStatus": "single",
        "stateCode": "CA",
    },
}


def test_every_tool_forwards_to_its_client_method():
    fake = _FakeClient()
    tools = {t.name: t for t in get_optionsahoy_tools(client=fake)}
    assert set(tools) == EXPECTED_NAMES
    assert set(MINIMAL_PAYLOADS) == EXPECTED_NAMES, "payload coverage drifted from tool set"
    for name, method in NAME_TO_METHOD.items():
        out = _invoke(tools[name], MINIMAL_PAYLOADS[name])
        assert out == {"ok": True, "method": method}, f"{name} routed to the wrong method"
        # The validated payload actually reached the client (not an empty dump).
        assert fake.calls[method], f"{name} forwarded no kwargs"


def test_qsbs_routes_through_client_with_kwargs():
    fake = _FakeClient()
    tools = {t.name: t for t in get_optionsahoy_tools(client=fake)}
    out = _invoke(
        tools["optionsahoy_qsbs_check"],
        {
            "acquisitionDate": "2018-01-01",
            "saleDate": "2026-02-01",
            "entityType": "us-c-corp",
            "acquisitionMethod": "original-issuance",
            "assetCategory": "under-50m",
            "industry": "tech-software",
            "activeBusiness": "yes",
            "adjustedBasis": 10000,
            "expectedGain": 2000000,
            "stateCode": "CA",
            "ordinaryIncome": 250000,
            "filingStatus": "single",
        },
    )
    assert out == {"ok": True, "method": "qsbs"}
    kwargs = fake.calls["qsbs"]
    assert kwargs["entityType"] == "us-c-corp"
    assert kwargs["expectedGain"] == 2000000


def test_nso_routes_to_nso_method():
    fake = _FakeClient()
    tools = {t.name: t for t in get_optionsahoy_tools(client=fake)}
    out = _invoke(
        tools["optionsahoy_nso_calculate"],
        {
            "shares": 1000,
            "strike": 2.0,
            "currentPrice": 20.0,
            "ordinaryIncome": 200000,
            "filingStatus": "single",
            "stateCode": "CA",
            "stillEmployed": True,
            "holdYears": 2,
            "holdFunding": "cash",
        },
    )
    assert out == {"ok": True, "method": "nso"}
    assert "nso" in fake.calls
    assert fake.calls["nso"]["shares"] == 1000


def test_invalid_args_raise_validation_error():
    fake = _FakeClient()
    tools = {t.name: t for t in get_optionsahoy_tools(client=fake)}
    with pytest.raises(Exception):
        # missing required fields
        _invoke(tools["optionsahoy_qsbs_check"], {"acquisitionDate": "2018-01-01"})
