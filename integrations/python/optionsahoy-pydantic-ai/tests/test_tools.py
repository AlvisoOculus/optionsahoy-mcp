# AlphaLatitude Inc. © 2026
"""Tests for the Pydantic AI OptionsAhoy tools.

The OptionsAhoy client is mocked so no network call is made; tests assert tool
shape (name, description, JSON schema) and that each tool forwards to the correct
client method with the right keyword arguments.
"""

from pydantic_ai import Agent, Tool
from pydantic_ai.toolsets.function import FunctionToolset

from optionsahoy_pydantic_ai import (
    get_optionsahoy_tools,
    optionsahoy_toolset,
    register_optionsahoy_tools,
)

EXPECTED_NAMES = {
    "optionsahoy_amt_iso_optimize",
    "optionsahoy_nso_calculate",
    "optionsahoy_rsu_sell_vs_hold",
    "optionsahoy_concentration_analyze",
    "optionsahoy_protective_put_price",
    "optionsahoy_qsbs_check",
    "optionsahoy_equity_funding_plan",
}

NAME_TO_METHOD = {
    "optionsahoy_amt_iso_optimize": "amt_iso",
    "optionsahoy_nso_calculate": "nso",
    "optionsahoy_rsu_sell_vs_hold": "rsu_sell_vs_hold",
    "optionsahoy_concentration_analyze": "concentration",
    "optionsahoy_protective_put_price": "protective_put",
    "optionsahoy_qsbs_check": "qsbs",
    "optionsahoy_equity_funding_plan": "equity_funding",
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


def test_returns_all_tools():
    tools = get_optionsahoy_tools()
    assert len(tools) == 7
    assert {t.name for t in tools} == EXPECTED_NAMES


def test_each_tool_shape():
    for tool in get_optionsahoy_tools():
        assert isinstance(tool, Tool)
        assert tool.name
        assert tool.description and len(tool.description) > 20
        schema = tool.function_schema.json_schema
        assert schema.get("type") == "object"
        assert schema.get("properties")


def test_descriptions_have_no_banned_characters():
    for tool in get_optionsahoy_tools():
        assert "—" not in tool.description  # em-dash
        assert "$" not in tool.description


def test_schema_mirrors_required_fields():
    by_name = {t.name: t for t in get_optionsahoy_tools()}
    schema = by_name["optionsahoy_qsbs_check"].function_schema.json_schema
    required = set(schema.get("required", []))
    for field in ("acquisitionDate", "saleDate", "entityType", "expectedGain"):
        assert field in schema["properties"]
        assert field in required


def test_every_tool_forwards_to_its_client_method():
    fake = _FakeClient()
    by_name = {t.name: t for t in get_optionsahoy_tools(client=fake)}
    assert set(by_name) == EXPECTED_NAMES
    # The forwarder Pydantic AI calls is `tool.function`; invoke each and confirm
    # it lands on the matching client method.
    minimal = {
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
    }
    # Route the two tools we have explicit payloads for.
    out = by_name["optionsahoy_qsbs_check"].function(**minimal["optionsahoy_qsbs_check"])
    assert out == {"ok": True, "method": "qsbs"}
    assert fake.calls["qsbs"]["entityType"] == "us-c-corp"
    assert fake.calls["qsbs"]["expectedGain"] == 2000000

    out = by_name["optionsahoy_nso_calculate"].function(**minimal["optionsahoy_nso_calculate"])
    assert out == {"ok": True, "method": "nso"}
    assert fake.calls["nso"]["shares"] == 1000

    # The remaining five forward to their mapped methods too.
    for name in EXPECTED_NAMES - set(minimal):
        method = NAME_TO_METHOD[name]
        result = by_name[name].function(foo="bar")
        assert result == {"ok": True, "method": method}
        assert fake.calls[method] == {"foo": "bar"}


def test_optionsahoy_toolset_holds_all_tools():
    toolset = optionsahoy_toolset(client=_FakeClient())
    assert isinstance(toolset, FunctionToolset)
    assert set(toolset.tools) == EXPECTED_NAMES


def test_register_optionsahoy_tools_onto_agent():
    fake = _FakeClient()
    agent = Agent("test")
    registered = register_optionsahoy_tools(agent, client=fake)
    assert {t.name for t in registered} == EXPECTED_NAMES
    assert EXPECTED_NAMES.issubset(set(agent._function_toolset.tools))
