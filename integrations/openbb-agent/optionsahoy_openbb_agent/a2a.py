# AlphaLatitude Inc. (c) 2026
"""A2A (Agent2Agent) interface for the OptionsAhoy Equity Planner.

Exposes the same equity-compensation routing as the OpenBB Workspace agent over
the Agent2Agent protocol, so other agents can discover this agent from its Agent
Card and delegate equity-compensation questions to it. Targets a2a-sdk 0.3.x
(Agent Card protocol version "0.3.0", served at /.well-known/agent-card.json).

The Agent Card is the discovery primitive: a calling agent fetches it, reads the
seven skills, and routes a question here. Each skill id is the OptionsAhoy tool
name that MCP ``tools/list`` publishes, so a capability found over MCP can be
delegated over A2A under the same name. The executor reuses the OpenBB agent's
tool layer (the same OptionsAhoy client and ``call_tool``), and its language-model
router is injectable, so the card and the routing can be tested without an API key.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.types import AgentCapabilities, AgentCard, AgentProvider, AgentSkill
from a2a.utils import new_agent_text_message

from optionsahoy import OptionsAhoyClient, OptionsAhoyError
from optionsahoy_openbb_agent.tools import TOOLS, TOOLS_BY_NAME, call_tool

AGENT_NAME = "OptionsAhoy Equity Planner"
AGENT_DESCRIPTION = (
    "Answers equity-compensation planning questions by calling the OptionsAhoy "
    "calculators: incentive stock option and alternative minimum tax (AMT) exercise "
    "timing, non-qualified stock options, restricted stock unit sell-versus-hold, "
    "qualified small business stock (QSBS), single-stock concentration, "
    "protective-put hedging, and funding a cash goal from equity. The financial math "
    "is deterministic and verifiable (https://optionsahoy.com/verification); "
    "OptionsAhoy's API is keyless."
)

# Default endpoint advertised in the card. Override with A2A_AGENT_URL once deployed.
DEFAULT_AGENT_URL = os.environ.get("A2A_AGENT_URL", "https://optionsahoy.com/a2a")

# Map each OpenBB tool-registry name (the ``OptionsAhoyClient`` method that
# ``call_tool`` invokes) to its canonical OptionsAhoy tool name. The canonical
# name is what MCP ``tools/list`` publishes and what this agent advertises as the
# A2A skill id, so a capability discovered over MCP can be delegated over A2A
# under the same name.
_SKILL_ID_BY_TOOL: Dict[str, str] = {
    "amt_iso": "amt_iso_optimize",
    "nso": "nso_calculate",
    "rsu_sell_vs_hold": "rsu_sell_vs_hold",
    "concentration": "concentration_analyze",
    "protective_put": "protective_put_price",
    "qsbs": "qsbs_check",
    "equity_funding": "equity_funding_plan",
}

# Human-readable skill name + discovery tags + one example per calculator, keyed
# by the A2A skill id (the OptionsAhoy/MCP tool name).
_SKILL_META: Dict[str, Dict[str, Any]] = {
    "amt_iso_optimize": {
        "name": "ISO exercise and AMT optimizer",
        "tags": ["iso", "amt", "exercise-timing", "equity-compensation", "tax"],
        "examples": [
            "When and how many of my 20,000 incentive stock options should I "
            "exercise over 4 years to minimize alternative minimum tax?"
        ],
    },
    "nso_calculate": {
        "name": "NSO exercise tax",
        "tags": ["nso", "non-qualified-stock-options", "tax"],
        "examples": [
            "How much tax will I owe if I exercise 5,000 non-qualified stock "
            "options, and should I sell at exercise or hold?"
        ],
    },
    "rsu_sell_vs_hold": {
        "name": "RSU sell-versus-hold",
        "tags": ["rsu", "vesting", "capital-gains"],
        "examples": [
            "My restricted stock units just vested. Should I sell now or hold for "
            "long-term capital gains?"
        ],
    },
    "concentration_analyze": {
        "name": "Single-stock concentration analysis",
        "tags": ["concentration", "single-stock-risk", "hedging"],
        "examples": [
            "Eighty percent of my net worth is in one company's stock. How much "
            "should I sell down?"
        ],
    },
    "protective_put_price": {
        "name": "Protective put, collar, and put spread pricing",
        "tags": [
            "hedging",
            "protective-put",
            "zero-cost-collar",
            "put-spread",
            "options-pricing",
        ],
        "examples": [
            "What would a protective put, a zero-cost collar, or a put spread on my "
            "10,000 shares cost?"
        ],
    },
    "qsbs_check": {
        "name": "QSBS Section 1202 check",
        "tags": ["qsbs", "section-1202", "tax-exclusion"],
        "examples": [
            "Do my shares qualify for the Section 1202 qualified small business "
            "stock exclusion?"
        ],
    },
    "equity_funding_plan": {
        "name": "Fund a cash goal from equity",
        "tags": ["equity-funding", "liquidity", "planning"],
        "examples": [
            "I need 200,000 dollars after tax for a down payment in 2 years. What "
            "should I sell and when?"
        ],
    },
}


def build_skills() -> List[AgentSkill]:
    """One AgentSkill per OptionsAhoy calculator, ids = the OptionsAhoy tool names."""
    skills: List[AgentSkill] = []
    for tool in TOOLS:
        skill_id = _SKILL_ID_BY_TOOL[tool["name"]]
        meta = _SKILL_META[skill_id]
        skills.append(
            AgentSkill(
                id=skill_id,
                name=meta["name"],
                description=tool["description"],
                tags=meta["tags"],
                examples=meta["examples"],
            )
        )
    return skills


def build_agent_card(url: str = DEFAULT_AGENT_URL) -> AgentCard:
    """Build the A2A Agent Card (protocol 0.3.0, no auth, the keyless agent)."""
    return AgentCard(
        protocol_version="0.3.0",
        name=AGENT_NAME,
        description=AGENT_DESCRIPTION,
        url=url,
        preferred_transport="JSONRPC",
        version="0.1.0",
        provider=AgentProvider(
            organization="AlphaLatitude Inc.", url="https://optionsahoy.com"
        ),
        capabilities=AgentCapabilities(
            streaming=False, push_notifications=False, state_transition_history=False
        ),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        documentation_url="https://optionsahoy.com/for-agents",
        icon_url="https://optionsahoy.com/icon.png",
        skills=build_skills(),
    )


def card_json(url: str = DEFAULT_AGENT_URL) -> Dict[str, Any]:
    """The Agent Card as a camelCase JSON-ready dict (what /.well-known serves)."""
    return build_agent_card(url).model_dump(by_alias=True, exclude_none=True)


# Router signature: conversation text -> (tool_name, arguments, fallback_text).
Selector = Callable[[str], Tuple[Optional[str], Dict[str, Any], Optional[str]]]


def _default_selector(conversation: str) -> Tuple[Optional[str], Dict[str, Any], Optional[str]]:
    """Production router: the OpenBB agent's language-model tool selector.

    Imported lazily so building the card or running the routing tests never pulls
    in the OpenAI client.
    """
    from optionsahoy_openbb_agent.main import select_tool

    return select_tool(conversation)


def _format_result(tool_name: str, result: Dict[str, Any]) -> str:
    """Render a calculator result as a text reply for the A2A message."""
    description = TOOLS_BY_NAME[tool_name]["description"]
    return (
        f"OptionsAhoy {tool_name} result ({description})\n\n"
        + json.dumps(result, indent=2, default=str)
    )


class OptionsAhoyAgentExecutor(AgentExecutor):
    """Routes an A2A message to a calculator and returns the result as text.

    ``selector`` and ``client_factory`` are injectable so the routing can be
    exercised without a language-model key or a live network call.
    """

    def __init__(
        self,
        selector: Optional[Selector] = None,
        client_factory: Optional[Callable[[], OptionsAhoyClient]] = None,
    ) -> None:
        self._selector = selector or _default_selector
        self._client_factory = client_factory or OptionsAhoyClient

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        text = context.get_user_input()
        if not text:
            await event_queue.enqueue_event(
                new_agent_text_message(
                    "Ask an equity-compensation question and I will run the matching "
                    "OptionsAhoy calculator."
                )
            )
            return

        tool_name, arguments, fallback_text = self._selector(text)

        if tool_name is None:
            await event_queue.enqueue_event(
                new_agent_text_message(fallback_text or "I could not determine an answer.")
            )
            return

        if tool_name not in TOOLS_BY_NAME:
            await event_queue.enqueue_event(
                new_agent_text_message(
                    "I could not match that question to an OptionsAhoy calculator."
                )
            )
            return

        client = self._client_factory()
        try:
            result = call_tool(client, tool_name, arguments)
        except OptionsAhoyError as exc:
            await event_queue.enqueue_event(
                new_agent_text_message(
                    f"The OptionsAhoy {tool_name} calculator could not complete this "
                    f"request: {exc}"
                )
            )
            return
        finally:
            client.close()

        await event_queue.enqueue_event(
            new_agent_text_message(_format_result(tool_name, result))
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError("OptionsAhoy A2A agent does not support cancel")


def add_a2a_routes(app: Any, url: str = DEFAULT_AGENT_URL) -> Any:
    """Graft the A2A JSON-RPC endpoint and Agent Card routes onto a FastAPI app."""
    from a2a.server.apps import A2AFastAPIApplication
    from a2a.server.request_handlers import DefaultRequestHandler
    from a2a.server.tasks import InMemoryTaskStore

    handler = DefaultRequestHandler(
        agent_executor=OptionsAhoyAgentExecutor(), task_store=InMemoryTaskStore()
    )
    a2a_app = A2AFastAPIApplication(agent_card=build_agent_card(url), http_handler=handler)
    a2a_app.add_routes_to_app(app)
    return app
