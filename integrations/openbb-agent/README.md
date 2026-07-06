# OptionsAhoy Equity Planner: an OpenBB Workspace agent

An OpenBB Workspace agent that answers equity-compensation planning questions by
calling the OptionsAhoy calculators. It implements the OpenBB agent protocol from
the [`openbb-ai`](https://pypi.org/project/openbb-ai/) software development kit:
a [FastAPI](https://fastapi.tiangolo.com/) application that exposes
`GET /agents.json` (the agent descriptor) and `POST /v1/query` (a stream of
Server-Sent Events).

## What it does

The agent answers questions such as:

- "How many incentive stock options (ISOs) should I exercise this year under the
  alternative minimum tax (AMT)?"
- "What are the after-tax proceeds if I exercise my non-qualified stock options
  (NSOs) and hold?"
- "Should I sell my restricted stock units (RSUs) at vest or hold them?"
- "Do my shares qualify for qualified small business stock (QSBS) treatment?"
- "How concentrated is my single-stock position, and what does diversifying cost
  after tax?"
- "What would a protective put, a zero-cost collar, or a put spread on my position
  cost?"
- "Which lots should I sell, and when, to fund a cash goal by a target date?"

For each question, a language model selects exactly one calculator and extracts its
inputs from the conversation. The agent then forwards those inputs to the keyless
OptionsAhoy REST API through the existing `optionsahoy` Python client and streams
the parsed result back as a short message plus a result table. The financial math
is computed by OptionsAhoy and returned verbatim; the model only routes the
question. **OptionsAhoy's API is keyless** (no OptionsAhoy API key is read, stored,
or sent).

## The OpenBB agent contract

`GET /agents.json` returns a descriptor keyed by the agent id:

```json
{
  "optionsahoy_equity_planner": {
    "name": "OptionsAhoy Equity Planner",
    "description": "...",
    "image": "https://optionsahoy.com/icon.png",
    "endpoints": { "query": "/v1/query" },
    "features": {
      "streaming": true,
      "widget-dashboard-select": false,
      "widget-dashboard-search": false
    }
  }
}
```

`POST /v1/query` accepts an `openbb-ai` `QueryRequest` (the message history and
workspace context) and returns `text/event-stream` Server-Sent Events built with
the `openbb-ai` helpers: a `reasoning_step` announcing the calculator, a
`message_chunk` with a short summary, and a `table` artifact holding the result
fields.

## Running locally

This package depends on the sibling `optionsahoy` client at
`integrations/python/optionsahoy`. Install both editable, from the repository root,
into a Python 3.10+ environment:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e integrations/python/optionsahoy
pip install -e "integrations/openbb-agent[dev]"
```

A language model is used to map each question onto a calculator. Copy
`.env.example` to `.env` and set `OPENAI_API_KEY`:

```bash
cp integrations/openbb-agent/.env.example integrations/openbb-agent/.env
# edit .env and set OPENAI_API_KEY
```

Run the agent:

```bash
cd integrations/openbb-agent
uvicorn optionsahoy_openbb_agent.main:app --reload --port 7777
```

Verify the descriptor:

```bash
curl http://localhost:7777/agents.json
```

## Adding it to OpenBB Workspace

1. Run the agent locally (or deploy it) so `GET /agents.json` is reachable.
2. In OpenBB Workspace, open the agents settings and add a custom agent.
3. Point it at your agent's base URL (Workspace reads `/agents.json` from there).
4. Select **OptionsAhoy Equity Planner** and ask an equity-compensation question.

## Agent-to-agent discovery (A2A)

The same agent can be discovered and called by other agents over the Agent2Agent
(A2A) protocol. Install the extra and the app additionally serves an Agent Card
and an A2A JSON-RPC endpoint:

```bash
pip install -e ".[a2a]"   # adds a2a-sdk; the OpenBB endpoints keep working without it
```

- `GET /.well-known/agent-card.json` returns the Agent Card (protocol version
  `0.3.0`): the agent's name, description, and one skill per OptionsAhoy
  calculator, so a calling agent can route a question here. The legacy
  `/.well-known/agent.json` path is served too. A committed copy of the card is in
  `.well-known/agent-card.json`.
- The A2A JSON-RPC endpoint accepts a message, routes it to a calculator (the same
  language-model selection layer as the OpenBB path), and returns the result.

Set `A2A_AGENT_URL` to the deployed endpoint so the card advertises the right
address (it defaults to `https://optionsahoy.com/a2a`). Once the card is hosted,
register it at a directory such as `a2aregistry.org` (POST the well-known URL) or
add it to the `awesome-a2a` list.

## Tests

The test suite needs neither a language-model API key nor network access. The
model-selection layer and the OptionsAhoy client are both replaced with fakes, so
the routing and the Server-Sent Event streaming are exercised end to end:

```bash
cd integrations/openbb-agent
pytest
ruff check .
```
