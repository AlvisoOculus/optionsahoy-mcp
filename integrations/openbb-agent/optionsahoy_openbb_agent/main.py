# AlphaLatitude Inc. (c) 2026
"""OptionsAhoy Equity Planner: an OpenBB Workspace agent.

This is a FastAPI application that speaks the OpenBB Workspace agent protocol from
the ``openbb-ai`` SDK. It exposes two endpoints:

- ``GET /agents.json`` returns the agent descriptor (name, description, query
  endpoint, feature flags) so OpenBB Workspace can register the agent.
- ``POST /v1/query`` receives a ``QueryRequest`` and replies with a stream of
  Server-Sent Events (SSE) built by the ``openbb-ai`` helpers.

The agent answers equity-compensation questions (incentive stock option and
alternative minimum tax exercise timing, non-qualified stock options, restricted
stock unit sell-versus-hold, qualified small business stock, single-stock
concentration, protective-put hedging, and funding a cash goal from equity). It
does this by selecting one of the OptionsAhoy calculators, extracting the
structured inputs from the question, calling the keyless OptionsAhoy REST API
through the existing ``optionsahoy`` Python client, and streaming the parsed
result back. OptionsAhoy's API requires no API key.

A language model (OpenAI, configured with ``OPENAI_API_KEY``) is used only to map
the natural-language question onto a calculator and its arguments. The financial
math is never done by the model: it is computed by OptionsAhoy and returned
verbatim. The model layer is isolated in ``select_tool`` so it can be replaced or
mocked in tests; no API key or network call is needed to test the agent's routing
and streaming.
"""

from __future__ import annotations

import json
import os
from typing import Any, AsyncGenerator, Dict, Optional, Tuple

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openbb_ai import message_chunk, reasoning_step, table
from openbb_ai.models import QueryRequest
from optionsahoy import OptionsAhoyClient, OptionsAhoyError
from sse_starlette.sse import EventSourceResponse

from optionsahoy_openbb_agent.tools import (
    TOOLS_BY_NAME,
    call_tool,
    openai_tool_specs,
)

AGENT_ID = "optionsahoy_equity_planner"
AGENT_NAME = "OptionsAhoy Equity Planner"
AGENT_DESCRIPTION = (
    "Answers equity-compensation planning questions by calling the OptionsAhoy "
    "calculators: incentive stock option and alternative minimum tax (AMT) exercise "
    "timing, non-qualified stock options, restricted stock unit sell-versus-hold, "
    "qualified small business stock (QSBS), single-stock concentration, "
    "protective-put hedging, and funding a cash goal from equity. OptionsAhoy's API "
    "is keyless."
)
AGENT_IMAGE = "https://optionsahoy.com/icon.png"

SYSTEM_PROMPT = (
    "You are the OptionsAhoy Equity Planner. You help equity holders with "
    "equity-compensation planning. For any question that one of the available tools "
    "can answer, call exactly one tool and extract its arguments from the "
    "conversation. Do not compute taxes or option values yourself; the tool returns "
    "the authoritative result. If the question is not about equity compensation, "
    "answer briefly in plain language without calling a tool."
)

app = FastAPI(title=AGENT_NAME)

# OpenBB Workspace is the only browser origin that calls this agent.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://pro.openbb.co"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/agents.json")
def get_agent_description() -> JSONResponse:
    """Return the OpenBB Workspace agent descriptor."""
    return JSONResponse(
        content={
            AGENT_ID: {
                "name": AGENT_NAME,
                "description": AGENT_DESCRIPTION,
                "image": AGENT_IMAGE,
                "endpoints": {"query": "/v1/query"},
                "features": {
                    "streaming": True,
                    "widget-dashboard-select": False,
                    "widget-dashboard-search": False,
                },
            }
        }
    )


def _conversation_text(request: QueryRequest) -> str:
    """Flatten the human and assistant turns into a single prompt-friendly string.

    Returns an empty string when the history contains no human turn, since there is
    no question to answer in that case.
    """
    lines = []
    has_human = False
    for message in request.messages:
        role = getattr(message, "role", None)
        content = getattr(message, "content", None)
        if role in ("human", "ai") and isinstance(content, str) and content:
            if role == "human":
                has_human = True
            speaker = "User" if role == "human" else "Assistant"
            lines.append(f"{speaker}: {content}")
    return "\n".join(lines) if has_human else ""


def select_tool(conversation: str) -> Tuple[Optional[str], Dict[str, Any], Optional[str]]:
    """Use a language model to choose a tool and extract its arguments.

    Returns a triple ``(tool_name, arguments, fallback_text)``:

    - If the model calls a tool, ``tool_name`` is its name and ``arguments`` the
      parsed keyword arguments; ``fallback_text`` is None.
    - If the model answers directly (no tool), ``tool_name`` is None and
      ``fallback_text`` carries the plain-language reply.

    This is the only function that talks to the language model. Tests replace it
    so the agent can be exercised without an API key or network access.
    """
    import openai

    client = openai.OpenAI()
    response = client.chat.completions.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": conversation},
        ],
        tools=openai_tool_specs(),
        tool_choice="auto",
    )
    choice = response.choices[0].message
    tool_calls = getattr(choice, "tool_calls", None)
    if tool_calls:
        first = tool_calls[0]
        name = first.function.name
        arguments = json.loads(first.function.arguments or "{}")
        return name, arguments, None
    return None, {}, (choice.content or "I could not determine an answer.")


def _build_client() -> OptionsAhoyClient:
    """Construct the keyless OptionsAhoy client. Overridable in tests via app state."""
    factory = getattr(app.state, "optionsahoy_client_factory", None)
    if factory is not None:
        return factory()
    return OptionsAhoyClient()


async def _run_query(request: QueryRequest) -> AsyncGenerator[Dict[str, Any], None]:
    """Drive the query: route to a tool, call OptionsAhoy, stream the result."""
    conversation = _conversation_text(request)
    if not conversation:
        yield message_chunk(
            "Ask an equity-compensation question and I will run the matching "
            "OptionsAhoy calculator."
        ).model_dump()
        return

    selector = getattr(app.state, "select_tool", select_tool)
    tool_name, arguments, fallback_text = selector(conversation)

    if tool_name is None:
        yield message_chunk(fallback_text or "").model_dump()
        return

    if tool_name not in TOOLS_BY_NAME:
        yield reasoning_step(
            f"The model requested an unknown tool: {tool_name}.",
            event_type="ERROR",
        ).model_dump()
        yield message_chunk(
            "I could not match that question to an OptionsAhoy calculator."
        ).model_dump()
        return

    description = TOOLS_BY_NAME[tool_name]["description"]
    yield reasoning_step(
        f"Calling the OptionsAhoy {tool_name} calculator.",
        details={"computes": description},
    ).model_dump()

    client = _build_client()
    try:
        result = call_tool(client, tool_name, arguments)
    except OptionsAhoyError as exc:
        yield reasoning_step(str(exc), event_type="ERROR").model_dump()
        yield message_chunk(
            "The OptionsAhoy calculator could not complete this request. "
            "Please check the inputs and try again."
        ).model_dump()
        return
    finally:
        client.close()

    yield message_chunk(
        f"Here is the OptionsAhoy {tool_name} result.\n\n"
    ).model_dump()
    yield table(
        data=_result_rows(result),
        name=f"OptionsAhoy {tool_name} result",
        description=description,
    ).model_dump()


def _result_rows(result: Dict[str, Any]) -> list[Dict[str, Any]]:
    """Flatten a parsed calculator result into rows of field and value.

    Nested objects and lists are rendered as compact JSON so the table stays a flat
    field-and-value grid regardless of which calculator produced the result.
    """
    rows = []
    for key, value in result.items():
        if isinstance(value, (dict, list)):
            rendered: Any = json.dumps(value, separators=(",", ":"))
        else:
            rendered = value
        rows.append({"field": key, "value": rendered})
    return rows


@app.post("/v1/query")
async def query(request: QueryRequest) -> EventSourceResponse:
    """Answer an equity-compensation question as a stream of Server-Sent Events."""
    return EventSourceResponse(
        content=_run_query(request),
        media_type="text/event-stream",
    )
