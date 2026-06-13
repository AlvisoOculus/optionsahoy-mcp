"""Tests for the LlamaIndex OptionsAhoy tool spec.

The OptionsAhoy client is mocked so no network call is made; tests assert tool shape
(name, description, fn_schema) and that invoking a tool routes through the client and
returns the parsed dict.
"""

from unittest.mock import MagicMock

import pytest
from llama_index.core.tools import FunctionTool

from llama_index.tools.optionsahoy import OptionsAhoyToolSpec

EXPECTED_NAMES = {
    "amt_iso_optimize",
    "nso_calculate",
    "rsu_sell_vs_hold",
    "concentration_analyze",
    "protective_put_price",
    "qsbs_check",
    "equity_funding_plan",
}


def test_returns_all_tools():
    tools = OptionsAhoyToolSpec(client=MagicMock()).to_tool_list()
    assert len(tools) == 7
    assert {t.metadata.name for t in tools} == EXPECTED_NAMES


def test_each_tool_has_name_description_schema():
    for tool in OptionsAhoyToolSpec(client=MagicMock()).to_tool_list():
        assert isinstance(tool, FunctionTool)
        assert tool.metadata.name
        assert tool.metadata.description and len(tool.metadata.description) > 20
        # fn_schema is derived from the function signature and exposes its fields
        fields = tool.metadata.fn_schema.model_fields
        assert len(fields) > 0


def test_descriptions_have_no_banned_characters():
    for tool in OptionsAhoyToolSpec(client=MagicMock()).to_tool_list():
        assert "—" not in tool.metadata.description  # em-dash
        assert "$" not in tool.metadata.description


def test_fn_schema_mirrors_required_fields():
    by_name = {t.metadata.name: t for t in OptionsAhoyToolSpec(client=MagicMock()).to_tool_list()}
    qsbs_fields = by_name["qsbs_check"].metadata.fn_schema.model_fields
    for required in ("acquisitionDate", "saleDate", "entityType", "expectedGain"):
        assert required in qsbs_fields
        assert qsbs_fields[required].is_required()


def test_invoking_tool_routes_through_client_and_returns_dict():
    fake = MagicMock()
    fake.qsbs.return_value = {"ok": True, "result": {"eligible": True}}
    tools = {t.metadata.name: t for t in OptionsAhoyToolSpec(client=fake).to_tool_list()}

    out = tools["qsbs_check"].call(
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

    assert out.raw_output == {"ok": True, "result": {"eligible": True}}
    fake.qsbs.assert_called_once()
    _, kwargs = fake.qsbs.call_args
    assert kwargs["entityType"] == "us-c-corp"
    assert kwargs["expectedGain"] == 2000000


def test_nso_tool_routes_to_nso_method():
    fake = MagicMock()
    fake.nso.return_value = {"ok": True}
    tools = {t.metadata.name: t for t in OptionsAhoyToolSpec(client=fake).to_tool_list()}
    out = tools["nso_calculate"].call(
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
    assert out.raw_output == {"ok": True}
    fake.nso.assert_called_once()


def test_invalid_args_raise_validation_error():
    tools = {t.metadata.name: t for t in OptionsAhoyToolSpec(client=MagicMock()).to_tool_list()}
    with pytest.raises(Exception):
        # missing required fields
        tools["qsbs_check"].call(acquisitionDate="2018-01-01")
