# AlphaLatitude Inc. (c) 2026
"""Tests for the OptionsAhoy Equity Planner OpenBB agent.

Neither a language-model API key nor network access is required. The language-model
selection layer is stubbed through ``app.state.select_tool`` and the OptionsAhoy
client is mocked through ``app.state.optionsahoy_client_factory``, so the routing
and Server-Sent Event streaming are exercised end to end against fakes.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from openbb_ai.testing import CopilotResponse

from optionsahoy_openbb_agent.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_sse_starlette_appstatus_event():
    """Reset the sse-starlette app status event between streaming tests.

    See https://github.com/sysid/sse-starlette/issues/59.
    """
    from sse_starlette.sse import AppStatus

    AppStatus.should_exit_event = None


@pytest.fixture(autouse=True)
def clean_app_state():
    """Clear any selector or client overrides left on app state by a previous test."""
    for attr in ("select_tool", "optionsahoy_client_factory"):
        if hasattr(app.state, attr):
            delattr(app.state, attr)
    yield
    for attr in ("select_tool", "optionsahoy_client_factory"):
        if hasattr(app.state, attr):
            delattr(app.state, attr)


def _human_payload(text: str) -> Dict[str, Any]:
    return {"messages": [{"role": "human", "content": text}]}


def _install_fakes(
    tool_name: str | None,
    arguments: Dict[str, Any],
    result: Dict[str, Any],
    fallback_text: str | None = None,
) -> Tuple[MagicMock, Dict[str, Any]]:
    """Wire a fake selector and a mocked OptionsAhoyClient onto the app.

    Returns the mock client and a dict capturing the selector call, so a test can
    assert which tool was chosen and which client method ran with which arguments.
    """
    captured: Dict[str, Any] = {}

    def fake_select_tool(conversation: str):
        captured["conversation"] = conversation
        return tool_name, arguments, fallback_text

    mock_client = MagicMock()
    if tool_name is not None:
        getattr(mock_client, tool_name).return_value = result

    app.state.select_tool = fake_select_tool
    app.state.optionsahoy_client_factory = lambda: mock_client
    return mock_client, captured


def _events(parsed: CopilotResponse, event_type: str):
    """Return parsed SSE events of a given OpenBB event type."""
    return [e for e in parsed.events if e.event_type == event_type]


def _status_text(parsed: CopilotResponse) -> str:
    return " ".join(str(e.content) for e in _events(parsed, "copilotStatusUpdate"))


def _artifacts(parsed: CopilotResponse):
    return _events(parsed, "copilotMessageArtifact")


# --- /agents.json descriptor ------------------------------------------------


def test_agents_json_shape():
    response = client.get("/agents.json")
    assert response.status_code == 200
    body = response.json()

    assert "optionsahoy_equity_planner" in body
    descriptor = body["optionsahoy_equity_planner"]

    assert descriptor["name"] == "OptionsAhoy Equity Planner"
    assert isinstance(descriptor["description"], str) and descriptor["description"]
    assert descriptor["endpoints"]["query"] == "/v1/query"

    features = descriptor["features"]
    assert features["streaming"] is True
    assert "widget-dashboard-select" in features
    assert "widget-dashboard-search" in features


# --- routing + streaming ----------------------------------------------------


def test_query_routes_to_amt_iso_and_streams_result():
    args = {
        "shares": 1000,
        "strike": 1.0,
        "fmv": 10.0,
        "filingStatus": "single",
        "ordinaryIncome": 200000,
        "stateCode": "CA",
        "carryforwardCredit": 0,
        "horizon": 3,
        "cashReturnRate": 0.04,
        "grantDate": "2022-01-01",
        "hasLeftCompany": False,
        "terminationDate": None,
    }
    result = {"recommendedExercise": 600, "amtDue": 12345, "schedule": [{"year": 2026}]}
    mock_client, captured = _install_fakes("amt_iso", args, result)

    response = client.post(
        "/v1/query",
        json=_human_payload("How many ISOs should I exercise this year under AMT?"),
    )
    assert response.status_code == 200

    # The chosen tool's client method ran exactly once with the extracted args.
    mock_client.amt_iso.assert_called_once_with(**args)
    assert "How many ISOs" in captured["conversation"]

    parsed = CopilotResponse(response.text)
    # A reasoning step announced the calculator, the message named the tool, and a
    # table artifact carried the parsed result fields.
    assert "amt_iso" in _status_text(parsed)
    assert "amt_iso" in parsed.text
    artifacts = _artifacts(parsed)
    assert artifacts, "expected a table artifact in the stream"
    rendered = str(artifacts[0].content)
    assert "recommendedExercise" in rendered
    assert "amtDue" in rendered


def test_query_routes_to_qsbs():
    args = {
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
    }
    result = {"eligible": True, "federalExclusion": 2000000}
    mock_client, _ = _install_fakes("qsbs", args, result)

    response = client.post(
        "/v1/query", json=_human_payload("Do my shares qualify for QSBS?")
    )
    assert response.status_code == 200
    mock_client.qsbs.assert_called_once_with(**args)
    # No other calculator was invoked.
    mock_client.amt_iso.assert_not_called()

    parsed = CopilotResponse(response.text)
    assert "federalExclusion" in str(_artifacts(parsed)[0].content)


def test_query_without_tool_streams_plain_answer():
    _install_fakes(
        None, {}, {}, fallback_text="I help with equity-compensation planning."
    )
    response = client.post(
        "/v1/query", json=_human_payload("What is the weather today?")
    )
    assert response.status_code == 200
    parsed = CopilotResponse(response.text)
    assert "equity-compensation planning" in parsed.text


def test_query_with_empty_conversation_prompts_user():
    # An assistant-only history yields no usable prompt text.
    response = client.post(
        "/v1/query",
        json={"messages": [{"role": "ai", "content": "Hello.", "agent_id": "x"}]},
    )
    assert response.status_code == 200
    parsed = CopilotResponse(response.text)
    assert "equity-compensation question" in parsed.text


def test_query_surfaces_optionsahoy_error():
    from optionsahoy import OptionsAhoyError

    args = {
        "positionValue": 500000,
        "sector": "tech",
        "protectionLevel": 0.9,
        "tenorYears": 1.0,
    }

    def fake_select_tool(conversation: str):
        return "protective_put", args, None

    mock_client = MagicMock()
    mock_client.protective_put.side_effect = OptionsAhoyError(
        "OptionsAhoy request to /api/v1/protective-put failed (400)"
    )
    app.state.select_tool = fake_select_tool
    app.state.optionsahoy_client_factory = lambda: mock_client

    response = client.post(
        "/v1/query", json=_human_payload("Price a protective put on my position.")
    )
    assert response.status_code == 200
    parsed = CopilotResponse(response.text)
    assert "failed" in _status_text(parsed)
    assert "could not complete" in parsed.text
    # The client is always closed, even on the error path.
    mock_client.close.assert_called_once()
