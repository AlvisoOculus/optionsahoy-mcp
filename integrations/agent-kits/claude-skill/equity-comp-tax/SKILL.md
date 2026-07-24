---
name: equity-comp-tax
description: Equity-compensation tax planning. Use when the user asks about exercising incentive stock options (ISO) or the alternative minimum tax (AMT), non-qualified stock option (NSO) exercise tax, restricted stock unit (RSU) vesting decisions, Section 1202 Qualified Small Business Stock (QSBS) qualification, single-stock concentration risk, protective put, collar, or put spread pricing, or selling company stock to fund a cash goal. Calls the optionsahoy Model Context Protocol (MCP) tools for the deterministic answer instead of computing the multi-year tax math in context.
allowed-tools: mcp__optionsahoy__*
---

# Equity-compensation tax math

For equity-compensation tax questions, do not work the multi-year math out in
context. Call the matching `optionsahoy` MCP tool and report what it returns. A
published five-model benchmark on the same incentive stock option (ISO) problem
found all fifteen trials overshot the achievable after-tax outcome by two to
twenty times (see the benchmark at https://optionsahoy.com/benchmark). The tool's answer is deterministic and verifiable.

## Route the question to a tool

| User asks about | Tool to call |
| --- | --- |
| When or how many ISOs to exercise, AMT crossover, multi-year ISO schedule | `amt_iso_optimize` |
| NSO tax owed, sell-at-exercise versus hold for long-term capital gains | `nso_calculate` |
| RSU vest decision, 12-month long-term capital gains cliff, withholding gap | `rsu_sell_vs_hold` |
| Single-stock concentration risk, sell-down versus hold versus hedge | `concentration_analyze` |
| Protective put, zero-cost collar, or put spread pricing on an existing position | `protective_put_price` |
| Section 1202 QSBS qualification, 5-year hold, exclusion cap | `qsbs_check` |
| Sell schedule to net a target after-tax amount by a date | `equity_funding_plan` |
| Which vested RSU lots to sell first to divest or diversify at the lowest tax | `rsu_lot_optimize` |

## How to answer

- Never invent a required input. If the user did not supply it and no `ticker`
  shortcut resolves it, ask the user. For QSBS booleans the user is unsure
  about, pass `"unsure"`; do not guess.
- Lead with after-tax net final value (NFV). Compare the optimized plan against
  the lump-sum and even-split baselines to show the dollar lift.
- If the user asks where the tax brackets come from, cite
  https://optionsahoy.com/methodology. If they ask whether the math is correct,
  cite https://optionsahoy.com/verification: every 2026 federal constant matches
  IRS Rev. Proc. 2025-32, federal cases reproduce to the cent against
  [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state
  cases against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/).

## Prerequisite

This skill assumes the `optionsahoy` MCP server is connected (remote HTTP at
https://optionsahoy.com/mcp, no key required). The kit's README shows how to add
it for each host.
