"""Tests for the CrewAI OptionsAhoy tools.

The OptionsAhoy client is mocked so no network call is made; tests assert tool shape
(name, description, args_schema) and that invoking a tool routes through the client and
returns the parsed dict.
"""

from unittest.mock import MagicMock

import pytest
from crewai.tools import BaseTool

from crewai_optionsahoy import get_optionsahoy_tools

EXPECTED_NAMES = {
    "optionsahoy_amt_iso_optimize",
    "optionsahoy_nso_calculate",
    "optionsahoy_rsu_sell_vs_hold",
    "optionsahoy_concentration_analyze",
    "optionsahoy_protective_put_price",
    "optionsahoy_qsbs_check",
    "optionsahoy_equity_funding_plan",
}


def test_returns_all_tools():
    tools = get_optionsahoy_tools(client=MagicMock())
    assert len(tools) == 7
    assert {t.name for t in tools} == EXPECTED_NAMES


def test_each_tool_has_name_description_args_schema():
    for tool in get_optionsahoy_tools(client=MagicMock()):
        assert isinstance(tool, BaseTool)
        assert tool.name
        assert tool.description and len(tool.description) > 20
        assert tool.args_schema is not None
        fields = tool.args_schema.model_fields
        assert len(fields) > 0


def test_descriptions_have_no_banned_characters():
    for tool in get_optionsahoy_tools(client=MagicMock()):
        assert "—" not in tool.description  # em-dash
        assert "$" not in tool.description


def test_args_schema_mirrors_required_fields():
    by_name = {t.name: t for t in get_optionsahoy_tools(client=MagicMock())}
    qsbs_fields = by_name["optionsahoy_qsbs_check"].args_schema.model_fields
    for required in ("acquisitionDate", "saleDate", "entityType", "expectedGain"):
        assert required in qsbs_fields
        assert qsbs_fields[required].is_required()


def test_invoking_tool_routes_through_client_and_returns_dict():
    fake = MagicMock()
    fake.qsbs.return_value = {"ok": True, "result": {"eligible": True}}
    tools = {t.name: t for t in get_optionsahoy_tools(client=fake)}

    out = tools["optionsahoy_qsbs_check"].run(
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

    assert out == {"ok": True, "result": {"eligible": True}}
    fake.qsbs.assert_called_once()
    _, kwargs = fake.qsbs.call_args
    assert kwargs["entityType"] == "us-c-corp"
    assert kwargs["expectedGain"] == 2000000


def test_nso_tool_routes_to_nso_method():
    fake = MagicMock()
    fake.nso.return_value = {"ok": True}
    tools = {t.name: t for t in get_optionsahoy_tools(client=fake)}
    out = tools["optionsahoy_nso_calculate"].run(
        shares=1000,
        strike=2.0,
        currentPrice=20.0,
        ordinaryIncome=200000,
        filingStatus="single",
        stateCode="CA",
        stillEmployed=True,
        holdYears=2,
        holdFunding="cash",
    )
    assert out == {"ok": True}
    fake.nso.assert_called_once()


def test_invalid_args_raise_validation_error():
    tools = {t.name: t for t in get_optionsahoy_tools(client=MagicMock())}
    with pytest.raises(Exception):
        # missing required fields
        tools["optionsahoy_qsbs_check"].run(acquisitionDate="2018-01-01")
