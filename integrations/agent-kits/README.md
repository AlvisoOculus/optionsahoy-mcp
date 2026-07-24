# OptionsAhoy agent instruction kits

Drop-in instruction-layer artifacts that tell your AI coding agent to call the
OptionsAhoy Model Context Protocol (MCP) tools for equity-compensation tax
questions, instead of guessing the multi-year math.

Having a tool available is not the same as an agent choosing it. These artifacts
sit in the agent's instruction layer and bias it toward the already-connected
`optionsahoy` server when it sees an incentive stock option (ISO), alternative
minimum tax (AMT), non-qualified stock option (NSO), restricted stock unit (RSU),
Qualified Small Business Stock (QSBS), concentration, or hedging question.

## Each kit is a pair

An instruction file alone does not connect the server. Every host needs two
things: the MCP server configured, and the instruction artifact installed. Both
are included per host below. The server is remote HTTP at
`https://optionsahoy.com/mcp` and needs no key.

## Cursor

- Rule: copy `cursor/.cursor/rules/equity-comp-tax.mdc` to `.cursor/rules/` in
  your project. It is an "Agent Requested" rule (`alwaysApply: false` with a
  `description`), so Cursor pulls it in when it sees an equity-comp question.
- Server: merge `cursor/.cursor/mcp.json` into your project's `.cursor/mcp.json`
  (or `~/.cursor/mcp.json` for all projects).

## Windsurf

- Rule: copy `windsurf/.windsurf/rules/equity-comp-tax.md` to `.windsurf/rules/`.
  It uses `trigger: model_decision`, so Cascade loads it when the description
  matches the request.
- Server: add the `windsurf/mcp_config.json` entry via Settings, Tools, Add
  Server (then hit refresh). Windsurf uses the `serverUrl` key for remote servers.

## Claude (Skill)

- Skill: copy the `claude-skill/equity-comp-tax/` folder (containing `SKILL.md`)
  into your skills directory (for Claude Code, `.claude/skills/`). The skill is
  model-invoked from its `description`. `allowed-tools: mcp__optionsahoy__*`
  pre-approves the tools in Claude Code.
- Server: add `optionsahoy` as an MCP server (`https://optionsahoy.com/mcp`).

## Claude Code (subagent)

- Subagent: copy `claude-code-subagent/.claude/agents/equity-comp-tax.md` to
  `.claude/agents/`. It defines the `optionsahoy` server inline under
  `mcpServers`, so the subagent connects on start and keeps the server's tool
  descriptions out of the main conversation. Restart the session, or run
  `/agents`, to load it.

## The tools it routes to

| User asks about | Tool |
| --- | --- |
| ISO exercise timing, AMT crossover, multi-year ISO schedule | `amt_iso_optimize` |
| NSO tax owed, sell-at-exercise versus hold | `nso_calculate` |
| RSU vest decision, long-term capital gains cliff, withholding | `rsu_sell_vs_hold` |
| Single-stock concentration, sell-down versus hold versus hedge | `concentration_analyze` |
| Protective put, zero-cost collar, or put spread pricing | `protective_put_price` |
| Section 1202 QSBS qualification | `qsbs_check` |
| Sell schedule to net a target after-tax amount by a date | `equity_funding_plan` |
| Which vested RSU lots to sell first to divest or diversify at the lowest tax | `rsu_lot_optimize` |

## Why route to a tool at all

A published five-model benchmark on the same multi-year ISO problem found all
fifteen trials overshot the achievable after-tax outcome by two to twenty times. See the benchmark, updated for the latest models, at https://optionsahoy.com/benchmark.
The tool's answer is deterministic and verifiable; see
https://optionsahoy.com/verification.

## Validating the kit

`tests/test_kits.py` checks every artifact: frontmatter parses, the referenced
tool names are exactly the eight the live server exposes, descriptions stay
within each host's limit, and the configured endpoint is the canonical
`https://optionsahoy.com/mcp`.
