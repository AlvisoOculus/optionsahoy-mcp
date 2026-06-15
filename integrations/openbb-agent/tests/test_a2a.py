# AlphaLatitude Inc. (c) 2026
"""Tests for the A2A interface: Agent Card validity and executor routing.

No network and no language-model key: the Agent Card is validated against the
a2a-sdk Pydantic models (equivalent to schema validation), and the executor's
router and OptionsAhoy client are injected as fakes.
"""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from a2a.types import AgentCard

from optionsahoy_openbb_agent.a2a import (
    OptionsAhoyAgentExecutor,
    build_agent_card,
    card_json,
)
from optionsahoy_openbb_agent.tools import TOOLS_BY_NAME

CARD_FILE = Path(__file__).resolve().parent.parent / ".well-known" / "agent-card.json"
TOOL_NAMES = set(TOOLS_BY_NAME)


class FakeQueue:
    def __init__(self):
        self.events = []

    async def enqueue_event(self, event):
        self.events.append(event)


def _text_of(event) -> str:
    return json.dumps(event.model_dump(by_alias=True), default=str)


def _run(executor, text):
    q = FakeQueue()
    ctx = SimpleNamespace(get_user_input=lambda: text)
    asyncio.run(executor.execute(ctx, q))
    return q


# -- Agent Card --------------------------------------------------------------

def test_card_validates_and_round_trips():
    data = card_json("https://optionsahoy.com/a2a")
    again = AgentCard.model_validate(data).model_dump(by_alias=True, exclude_none=True)
    assert again == data


def test_card_required_fields_and_version():
    data = card_json()
    for field in ("protocolVersion", "name", "description", "url", "version",
                  "capabilities", "defaultInputModes", "defaultOutputModes", "skills"):
        assert field in data, f"card missing required field {field}"
    assert data["protocolVersion"] == "0.3.0"
    assert data["preferredTransport"] == "JSONRPC"


def test_skills_cover_all_seven_tools():
    skill_ids = {s["id"] for s in card_json()["skills"]}
    assert skill_ids == TOOL_NAMES
    for s in card_json()["skills"]:
        assert s["name"] and s["description"] and s["tags"]


def test_static_card_matches_generated():
    on_disk = json.loads(CARD_FILE.read_text())
    assert on_disk == card_json("https://optionsahoy.com/a2a"), (
        "committed .well-known/agent-card.json is stale; regenerate it"
    )


def test_card_url_is_configurable():
    assert build_agent_card("https://example.com/x").url == "https://example.com/x"


# -- Executor routing --------------------------------------------------------

def _executor(tool_name, arguments, result):
    mock_client = MagicMock()
    getattr(mock_client, tool_name).return_value = result

    def selector(_conv):
        return tool_name, arguments, None

    return (
        OptionsAhoyAgentExecutor(selector=selector, client_factory=lambda: mock_client),
        mock_client,
    )


def test_executor_routes_to_tool_and_returns_result():
    executor, mock_client = _executor(
        "amt_iso", {"shares": 20000}, {"optimized": {"nfv": 739600.82}}
    )
    q = _run(executor, "When should I exercise my ISOs?")
    assert len(q.events) == 1
    body = _text_of(q.events[0])
    assert "amt_iso" in body and "739600" in body
    mock_client.amt_iso.assert_called_once_with(shares=20000)
    mock_client.close.assert_called_once()


def test_executor_empty_input_prompts():
    executor, _ = _executor("amt_iso", {}, {})
    q = _run(executor, "")
    assert "equity-compensation question" in _text_of(q.events[0])


def test_executor_passthrough_when_no_tool():
    def selector(_conv):
        return None, {}, "I only handle equity-compensation questions."

    executor = OptionsAhoyAgentExecutor(selector=selector, client_factory=MagicMock())
    q = _run(executor, "what is the weather")
    assert "equity-compensation" in _text_of(q.events[0])


def test_executor_unknown_tool_is_handled():
    executor = OptionsAhoyAgentExecutor(
        selector=lambda _c: ("not_a_tool", {}, None), client_factory=MagicMock()
    )
    q = _run(executor, "x")
    assert "could not match" in _text_of(q.events[0]).lower()


def test_executor_reports_calculator_error():
    from optionsahoy import OptionsAhoyError

    mock_client = MagicMock()
    mock_client.amt_iso.side_effect = OptionsAhoyError("bad input")
    executor = OptionsAhoyAgentExecutor(
        selector=lambda _c: ("amt_iso", {}, None), client_factory=lambda: mock_client
    )
    q = _run(executor, "x")
    assert "could not complete" in _text_of(q.events[0])
    mock_client.close.assert_called_once()


# -- Mount integration (needs fastapi + a2a-sdk[http-server]) -----------------

def test_a2a_routes_serve_card_on_fastapi_app():
    import pytest

    pytest.importorskip("fastapi")
    pytest.importorskip("sse_starlette")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from optionsahoy_openbb_agent.a2a import add_a2a_routes

    app = FastAPI()
    add_a2a_routes(app, url="https://optionsahoy.com/a2a")
    client = TestClient(app)

    current = client.get("/.well-known/agent-card.json")
    assert current.status_code == 200
    assert current.json()["protocolVersion"] == "0.3.0"
    assert len(current.json()["skills"]) == len(TOOL_NAMES)
    # The legacy path is also served for older clients.
    assert client.get("/.well-known/agent.json").status_code == 200
