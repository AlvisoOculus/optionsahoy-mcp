# OptionsAhoy agent-builder templates

Pre-built "Equity Comp Tax Planner" building blocks for no-code and low-code AI
agent builders. Each calls the keyless OptionsAhoy optimizer (no API key) and
returns the incentive stock option (ISO) exercise schedule that maximizes
after-tax net final value (NFV). A builder drops this into their flow and ships
equity-compensation planning to their own users.

## The call every template makes

All of these hit one keyless endpoint:

```
POST https://optionsahoy.com/api/v1/amt-iso
content-type: application/json

{ "shares": 20000, "strike": 2, "fmv": 200, "filingStatus": "married_joint",
  "ordinaryIncome": 300000, "stateCode": "CA", "carryforwardCredit": 0,
  "horizon": 4, "cashReturnRate": 0.055, "grantDate": "2022-01-01",
  "hasLeftCompany": false, "expectedGrowth": 0.17, "volatility": 0.72 }
```

Read the answer at `result.schedules.optimized.nfv`, compared against
`result.schedules.lumpSum.nfv` and `result.schedules.evenSplit.nfv`. Other
endpoints: `/api/v1/nso`, `/api/v1/rsu-sell-vs-hold`, `/api/v1/qsbs`,
`/api/v1/concentration`, `/api/v1/protective-put`, `/api/v1/equity-funding`.
Full schema at https://optionsahoy.com/openapi.json. The same tools are also a
remote Model Context Protocol (MCP) server at `https://optionsahoy.com/mcp`.

## n8n (importable)

`n8n/equity-comp-tax-planner.n8n.json` is a ready-to-import workflow: a sample
scenario (Set node) feeding an HTTP Request to the optimizer. Import it from
Workflows, Import from File. To make it a chat agent, swap the trigger and Set
node for a Chat Trigger and an AI Agent, and attach the OptionsAhoy MCP server
with an MCP Client Tool node (`serverTransport: httpStreamable`, `endpointUrl:
https://optionsahoy.com/mcp`).

Validation level: the workflow is structurally validated against n8n's node
schema and its embedded scenario is verified against the live API (see `tests/`).
Import it into your own n8n instance to confirm before submitting it to the
Creator hub.

## Flowise, Langflow, Dify (build and export)

These three platforms generate their flow files from the GUI (their exports
embed per-node component code or version-pinned connection handles, so a
hand-written file does not reliably import across versions). Build the planner
once in the GUI and export it for your gallery submission. The flow is three
steps everywhere:

**Flowise** (Chatflow): Chat Input, then an LLM or Agent node, then a tool. Use
the `Custom MCP` tool (Tools, MCP) pointed at `https://optionsahoy.com/mcp`, or a
`Requests Post` node to the REST endpoint above. Wire to Chat Output.

**Langflow**: Chat Input, then an Agent component with the `MCP Tools` component
(HTTP or Streamable HTTP mode, URL `https://optionsahoy.com/mcp`), then Chat
Output. For the REST path use the `API Request` component instead.

**Dify** (Workflow app): Start (collect the scenario fields), then an HTTP
Request node (POST, the URL and JSON body above; the keyless REST endpoint is
the portable choice over a custom OpenAPI tool), then an LLM node to format the
result, then End. Export the Difypacked DSL pinned to the current version.

## Why route to the tool

A published five-model benchmark on the same multi-year ISO problem found all
fifteen trials overshot the achievable after-tax outcome by two to twenty times.
The optimizer's answer is deterministic and verifiable; see
https://optionsahoy.com/verification.

## Validating

```bash
pip install -e "integrations/eval[dev]"   # reuses the eval's pytest + deps
pytest integrations/agent-builder-templates/tests
OA_LIVE=1 pytest integrations/agent-builder-templates/tests   # also POSTs the live payload
```

The tests check the n8n workflow's structure (required keys, node shape,
connections resolve by name, the OptionsAhoy endpoint and method are present)
and, with `OA_LIVE=1`, that the embedded scenario returns a valid optimized NFV
from the live API.

## Distribution endpoints (where these get discovered)

- n8n: submit via the n8n Creator hub (publishes to `n8n.io/workflows/...`).
- Flowise: PR the exported JSON to `FlowiseAI/Flowise` under
  `packages/server/marketplaces/`.
- Langflow: PR the exported JSON to `langflow-ai/langflow` under
  `initial_setup/starter_projects/` (surfaces in the Templates gallery).
- Dify: submit the app via the Dify Creator Center, or share the DSL directly.
