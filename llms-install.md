# Installing OptionsAhoy MCP

OptionsAhoy is a remote HTTP MCP server. The recommended install is the hosted
endpoint: no download, no build, no API key.

## Remote (recommended, all clients)

Endpoint: `https://optionsahoy.com/mcp` (Streamable HTTP, no authentication).

For clients configured via JSON (Cline, Cursor, and most others), add this to
the MCP settings:

```json
{
  "mcpServers": {
    "optionsahoy": {
      "url": "https://optionsahoy.com/mcp",
      "type": "streamableHttp"
    }
  }
}
```

Cline: Settings -> MCP Servers -> Remote Servers -> Add server, name `optionsahoy`,
URL `https://optionsahoy.com/mcp`. Some clients use `"type": "streamable-http"` or a
`--transport http` flag; the endpoint is the same in all cases.

Claude Desktop: download [`optionsahoy.mcpb`](https://github.com/AlvisoOculus/optionsahoy-mcp/releases/latest/download/optionsahoy.mcpb)
and double-click it (Claude Desktop installs local bundles rather than remote URLs).

Verify the install by asking the model: "Which OptionsAhoy tools are available?"
The server exposes 8 tools: amt_iso_optimize, nso_calculate, rsu_sell_vs_hold,
concentration_analyze, protective_put_price, qsbs_check, equity_funding_plan,
rsu_lot_optimize.

## Local (optional)

The server is also published on npm as a local stdio server. For clients that
prefer or require a local process:

```json
{
  "mcpServers": {
    "optionsahoy": {
      "command": "npx",
      "args": ["-y", "optionsahoy-mcp"]
    }
  }
}
```

Requirements: Node 20 or newer. No environment variables are needed.

## Notes for AI agents

- Do not invent numeric inputs. If share counts, strike, income, or state are
  unknown, ask the user.
- Full agent documentation: https://optionsahoy.com/for-agents
