# AlphaLatitude Inc. © 2026
"""Tests for the Arcade OptionsAhoy toolkit.

The OptionsAhoy client is monkeypatched so no network call is made; tests assert that the
toolkit registers all eight tools in an Arcade ToolCatalog with the expected names, that the
tool definitions are well formed, and that invoking a tool routes through the client and
returns the parsed dict.
"""

import arcade_optionsahoy
import pytest
from arcade_tdk import ToolCatalog

EXPECTED_NAMES = {
    "AmtIsoOptimize",
    "NsoCalculate",
    "RsuSellVsHold",
    "ConcentrationAnalyze",
    "ProtectivePutPrice",
    "QsbsCheck",
    "EquityFundingPlan",
    "RsuLotOptimize",
}


def _catalog() -> ToolCatalog:
    catalog = ToolCatalog()
    catalog.add_module(arcade_optionsahoy)
    return catalog


def test_catalog_registers_all_eight_tools():
    catalog = _catalog()
    assert len(catalog) == 8
    names = {tool.definition.name for tool in catalog}
    assert names == EXPECTED_NAMES


def test_each_tool_has_name_and_description():
    for tool in _catalog():
        assert tool.definition.name in EXPECTED_NAMES
        assert tool.definition.description and len(tool.definition.description) > 20


def test_descriptions_have_no_banned_characters():
    for tool in _catalog():
        assert "—" not in tool.definition.description  # em-dash
        assert "$" not in tool.definition.description


def test_amt_iso_input_schema_has_required_params():
    by_name = {t.definition.name: t for t in _catalog()}
    params = {p.name for p in by_name["AmtIsoOptimize"].definition.input.parameters}
    for required in ("shares", "strike", "fmv", "filing_status", "horizon", "grant_date"):
        assert required in params


def test_invoking_qsbs_routes_through_client(monkeypatch):
    captured = {}

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

        def qsbs(self, **kwargs):
            captured.update(kwargs)
            return {"ok": True, "result": {"verdict": "qualifies"}}

    monkeypatch.setattr(arcade_optionsahoy.tools, "OptionsAhoyClient", lambda *a, **k: FakeClient())

    out = arcade_optionsahoy.qsbs_check(
        acquisition_date="2018-01-01",
        sale_date="2026-02-01",
        entity_type="us-c-corp",
        acquisition_method="original-issuance",
        asset_category="under-50m",
        industry="tech-software",
        active_business="yes",
        adjusted_basis=10000,
        expected_gain=2000000,
        state_code="CA",
        ordinary_income=250000,
        filing_status="single",
    )

    assert out == {"ok": True, "result": {"verdict": "qualifies"}}
    assert captured["entityType"] == "us-c-corp"
    assert captured["expectedGain"] == 2000000
    assert captured["filingStatus"] == "single"


def test_invoking_nso_routes_to_nso_method(monkeypatch):
    calls = []

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

        def nso(self, **kwargs):
            calls.append(kwargs)
            return {"ok": True}

    monkeypatch.setattr(arcade_optionsahoy.tools, "OptionsAhoyClient", lambda *a, **k: FakeClient())

    out = arcade_optionsahoy.nso_calculate(
        shares=1000,
        strike=2.0,
        current_price=20.0,
        ordinary_income=200000,
        filing_status="single",
        state_code="CA",
        still_employed=True,
        hold_years=2,
        hold_funding="cash",
    )
    assert out == {"ok": True}
    assert len(calls) == 1
    assert calls[0]["currentPrice"] == 20.0
    assert calls[0]["holdFunding"] == "cash"
