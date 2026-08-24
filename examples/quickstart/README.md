# OptionsAhoy MCP — quickstart

Three runnable Node scripts that hit the hosted MCP at
`https://optionsahoy.com/mcp` and print a result. No SDK, no auth,
no install — just `fetch` over JSON-RPC. Fork this directory into
CodeSandbox, Replit, or a local checkout and run.

## Run in the cloud (no install)

[![Open in CodeSandbox](https://codesandbox.io/static/img/play-codesandbox.svg)](https://codesandbox.io/p/github/AlvisoOculus/optionsahoy-mcp/main?import=true&file=/examples/quickstart/README.md)
[![Run on Replit](https://replit.com/badge/github/AlvisoOculus/optionsahoy-mcp)](https://replit.com/github/AlvisoOculus/optionsahoy-mcp)

Once the sandbox boots, open `examples/quickstart/` and run any of:

```bash
npm run list           # list every tool the MCP exposes
npm run concentration  # single-stock concentration risk for $750K NVDA
npm run amt-iso        # multi-year ISO exercise plan, 8000 shares at $5 strike
```

## Run locally

```bash
git clone https://github.com/AlvisoOculus/optionsahoy-mcp
cd optionsahoy-mcp/examples/quickstart
node list-tools.mjs
node call-concentration.mjs
node call-amt-iso.mjs
```

Node 18+ required (uses the global `fetch`).

## What it does

- **`list-tools.mjs`** — JSON-RPC `tools/list`, prints every tool name + first line of its description.
- **`call-concentration.mjs`** — JSON-RPC `tools/call` to `concentration_analyze` with a ticker (`NVDA`). The server resolves implied vol as of the last close + a trailing return so you don't pass them.
- **`call-amt-iso.mjs`** — JSON-RPC `tools/call` to `amt_iso_optimize`, prints the lump-sum vs optimized NFV and the optimizer's lift.

Same endpoint Claude / Cursor / VS Code hit when they call OptionsAhoy as an MCP. Same response shape too — these scripts just skip the MCP client wrapper and POST JSON-RPC directly.

For richer integration patterns (full MCP client, streamable-http transport, MCP resources/prompts) see the parent README and the install grid at [optionsahoy.com/for-agents](https://optionsahoy.com/for-agents).
