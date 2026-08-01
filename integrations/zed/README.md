# OptionsAhoy for Zed

A [Zed](https://zed.dev) context-server extension that connects the editor's
agent to the **OptionsAhoy** MCP server — an equity-compensation tax and trade
optimizer.

## What it does

OptionsAhoy gives the Zed agent tools for equity-compensation planning,
computed against the relevant federal tax code plus all 50 states and DC
(the ISO optimizer exhaustively enumerates its candidate space, globally
optimal within the modeled problem; the rest are exact deterministic
computations):

- Incentive stock option (ISO) exercise and alternative minimum tax (AMT)
- Non-qualified stock option (NSO) calculations
- Restricted stock unit (RSU) sell-vs-hold
- Qualified small business stock (QSBS) eligibility
- Single-stock concentration analysis
- Protective-put hedging
- Vested restricted stock unit (RSU) lot sell order, lowest tax versus first-in-first-out (FIFO)

## How it works

OptionsAhoy runs as a remote streamable-HTTP MCP server at
`https://optionsahoy.com/mcp` (no authentication). Zed context-server extensions
launch a local stdio command, so this extension bridges to the remote server
with the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) npm shim. Zed
manages installing and updating that bridge automatically.

## Install

Open Zed, go to **Extensions**, search for **OptionsAhoy**, and click install.
The OptionsAhoy context server starts automatically — no configuration required.

## Links

- Website: https://optionsahoy.com
- For agents: https://optionsahoy.com/for-agents
- MCP server source: https://github.com/AlvisoOculus/optionsahoy-mcp

## License

MIT — AlphaLatitude Inc. © 2026
