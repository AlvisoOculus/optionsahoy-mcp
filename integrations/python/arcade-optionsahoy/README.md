# arcade-optionsahoy

[![PyPI version](https://img.shields.io/pypi/v/arcade-optionsahoy.svg)](https://pypi.org/project/arcade-optionsahoy/)
[![Python versions](https://img.shields.io/pypi/pyversions/arcade-optionsahoy.svg)](https://pypi.org/project/arcade-optionsahoy/)
[![License: MIT](https://img.shields.io/pypi/l/arcade-optionsahoy.svg)](https://github.com/AlvisoOculus/optionsahoy-mcp/blob/main/LICENSE)

An [Arcade](https://arcade.dev) toolkit for the OptionsAhoy equity-compensation calculators. One `@tool`-decorated function per OptionsAhoy REST endpoint, built on the keyless [`optionsahoy`](https://pypi.org/project/optionsahoy/) client and the [`arcade-tdk`](https://pypi.org/project/arcade-tdk/) Tool Development Kit. No OptionsAhoy account, no application programming interface (API) key, full federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. See the benchmark, updated for the latest models, at https://optionsahoy.com/benchmark. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## Verified

Beyond determinism, the tax math is independently verified, every release: every 2026 federal constant matches its IRS Rev. Proc. 2025-32 value, worked federal cases reproduce to the cent against the independently-maintained [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state tax reproduces to the cent against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/) across CA, NY, NJ, PA, and MA, with the headline answer recomputed live in your browser. Proof, shown beside the public sources: https://optionsahoy.com/verification

## What it provides

The toolkit exposes eight Arcade tools, each a `@tool`-decorated function with `typing.Annotated` parameters mirroring its endpoint:

- `AmtIsoOptimize` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `NsoCalculate` - non-qualified stock option (NSO) exercise tax, sell-at-exercise versus hold
- `RsuSellVsHold` - restricted stock unit (RSU) sell at vest versus hold for long-term capital gains
- `ConcentrationAnalyze` - single-stock concentration risk and the after-tax cost of diversifying
- `ProtectivePutPrice` - protective put, zero-cost collar, and put spread pricing
- `QsbsCheck` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `EquityFundingPlan` - multi-year plan to fund a cash goal from equity by a target date
- `RsuLotOptimize` - which vested RSU lots to sell, and when, to divest a target fraction at the lowest tax

Coverage spans the full federal tax code plus all 50 states and DC. The toolkit pulls in the keyless `optionsahoy` client automatically. No API key is read, stored, or sent anywhere. Set `OPTIONSAHOY_BASE_URL` to point the tools at a different host.

## Tools: inputs and outputs

Each tool's parameters list the required fields below; every tool also accepts optional forward-looking fields (such as `expected_sale_price`, `volatility`, `expected_market_return`) and, where noted, a convenience `ticker` so the API can derive forward-looking inputs from that symbol. Returns are the top-level fields of the response, wrapped as `{"ok": true, "result": {...}}`; the fields below are those of `result`.

### `AmtIsoOptimize`
Optimizes a multi-year incentive stock option (ISO) exercise schedule under the alternative minimum tax (AMT): how many shares to exercise each year so the after-tax outcome is best.
- Inputs (required): `shares`, `strike` (USD), `fmv` (USD), `filing_status` (`single` | `married_joint` | `head_household`), `ordinary_income` (USD), `state_code` (two-letter, or `DC`), `carryforward_credit` (USD), `horizon` (1 to 10), `grant_date` (YYYY-MM-DD), `has_left_company` (boolean), `termination_date` (YYYY-MM-DD, or null if still employed).
- Optional: `cash_return_rate` (decimal; defaults to 0.04 when omitted), `expected_growth` (decimal), `volatility` (decimal), `volatility_drag` (0 to 0.99), `ticker` (covered public symbol).
- Returns: `crossoverShares` and `crossoverBargain` (where AMT starts to bite this year); `alreadyInAmt` and `stateHasAmt` (booleans); `bargainPerShare`; `effectiveHorizon`; `timing` (key dates); and `schedules` with three strategies `lumpSum`, `evenSplit`, and `optimized`, each carrying per-year tax, AMT owed and credit, long-term capital-gains tax at final sale, and `nfv` (net future value).

### `NsoCalculate`
Computes the tax and after-tax proceeds of exercising non-qualified stock options (NSOs), comparing selling at exercise against holding for later long-term capital gains.
- Inputs (required): `shares`, `strike` (USD), `current_price` (USD), `ordinary_income` (USD), `filing_status`, `state_code`, `still_employed` (boolean), `hold_years` (at least 1), `hold_funding` (`sell-to-cover` | `cash`).
- Optional: `expected_sale_price` (USD), `haircut` (0 to 1), `volatility` (decimal), `expected_market_return` (decimal), `ticker`.
- Returns: `exercise` (ordinary income and taxes at exercise, plus net cash if you sell every share); `bracketJump`; `hold` (the hold-and-sell-later path); `sellNowInvest` (sell now and invest the proceeds); `holdMinusCashless` (positive favors holding).

### `RsuSellVsHold`
Compares selling vested restricted stock units (RSUs) at vest against holding them, on an after-tax, risk-adjusted basis.
- Inputs (required): `shares`, `current_price` (USD), `ordinary_income` (USD), `filing_status`, `state_code`, `still_employed` (boolean), `hold_years` (0.25 to 5).
- Optional: `expected_sale_price` (USD), `haircut` (0 to 1), `volatility` (decimal), `expected_market_return` (decimal), `ticker`.
- Returns: `vest` (taxes due at vest); `bracketJump`; `hold`; `sellNowInvest`; `holdMinusSell` (positive favors holding).

### `ConcentrationAnalyze`
Quantifies single-stock concentration risk and compares the after-tax cost of three responses: sell down, hold, or hedge.
- Inputs (required): `position_value` (USD), `cost_basis` (USD), `acquisition_date` (YYYY-MM-DD), `sector` (one of `tech_software`, `semiconductors`, `consumer_cyclical`, `consumer_defensive`, `financials`, `healthcare_biotech`, `energy`, `industrials`, `communication`, `broad_market`), `state_code`, `filing_status`, `ordinary_income` (USD), `total_assets` (USD).
- Optional: `expected_position_return` and `expected_market_return` (decimals), or `ticker`; `volatility` (decimal), `volatility_drag` (0 to 0.99), `hedge_choice` (`{kind, protectionLevel, tenorYears, upsideCapPct}`).
- Returns: `concentration` (0 to 1); `riskBand`; `isLongTermToday`, `longTermDate`, `daysUntilLongTerm`; `lossExposure[]`; `schedule[]` (after-tax sell-down plans); `hedging` (present when `hedge_choice` is given); `sectorContextLine` and `advisorBenchmarkLine`.

### `ProtectivePutPrice`
Prices a protective put, a zero-cost collar, and a put spread for a stock position at a chosen downside-protection level and tenor. The put spread finances the same floor with a short put instead of a short call, cheaper than the bare put, and needs no short call (so it works on unexercised employee options a collar cannot cover); protection stops at the short strike and losses resume below it.
- Inputs (required): `position_value` (USD), `sector` (same set as concentration), `protection_level` (0.05 to 0.5), `tenor_years` (at least 0.25).
- Optional: `volatility` (decimal), `expected_return` (decimal), `ticker_label`, `spread_risk_level` (floor breach probability for the put spread, presets 0.20 / 0.10 / 0.05 / 0.01, default 0.10).
- Returns: `inputs`; `riskFreeRate` and `realWorldDrift`; `barePut` (the put alone); `collar` (put financed by selling a call, with `upsideCap` and `isZeroCost`); `putSpread` (put financed by selling a lower-strike put, with long and short strikes and net cost); `payoffTable[]`; `payoffRange`; `recommended` (`bare-put` | `collar` | `put-spread` | `none`).

### `QsbsCheck`
Checks qualified small business stock (QSBS) Section 1202 eligibility and computes the resulting federal capital-gains exclusion.
- Inputs (required): `acquisition_date` and `sale_date` (YYYY-MM-DD), `entity_type` (`us-c-corp` | `other`), `acquisition_method` (`original-issuance` | `gift-or-inheritance` | `secondary` | `unsure`), `asset_category` (`under-50m` | `50m-to-75m` | `over-75m` | `unsure`), `industry` (see the tool docstring for the full enum), `active_business` (`yes` | `no` | `unsure`), `adjusted_basis` (USD), `expected_gain` (USD), `state_code`, `ordinary_income` (USD), `filing_status`.
- Returns: `verdict`; `exclusionPercent` (0 to 1); `perIssuerCap`, `tenXBasisCap`, `applicableCap`; `excludableGain` and `taxableGain`; `federalTaxSaved`; `stateConforms` and `stateNote`; `holdingYears`; `yearsUntilFullExclusion`; `era`; `tests[]`.

### `EquityFundingPlan`
Plans which equity lots to sell, and when, to fund a cash goal by a target date at the least after-tax cost, accounting for holding-period thresholds and shortfall risk.
- Inputs (required): `target_after_tax` (USD), `target_date` (YYYY-MM-DD), `ordinary_income` (USD), `filing_status`, `state_code`, plus the holdings as either `stacks` (preferred: a list of stacks, each with `currentPrice` and a `lots` list of `{shares, costBasisPerShare, acquisitionDate, vestDate?}`) or the legacy `lots` plus a single `current_price`.
- Optional: `expected_annual_growth` (decimal), `cash_interest_rate` (decimal), `risk_tolerance_shortfall` (0 to 1), `default_volatility` (decimal).
- Returns: four named plans `recommended`, `lockInNow`, `balanced`, `holdForGrowth`, plus `frontier[]`, and the echoed `targetAfterTax`, `targetDateISO`, `appliedRiskTolerance`. Each plan carries `wealthAtTarget`, `totalTax`, `shortfallProbability`, and a `plan` with `feasible`, `schedule` (per-year sales), `comparison`, and `remainingShares`.

### `RsuLotOptimize`
Chooses which vested restricted stock unit (RSU) lots to sell, and when, to divest a target share fraction at the lowest tax, using specific-lot identification, long-term deferral, and multi-year bracket spreading, versus a first-in-first-out (FIFO) sell order.
- Inputs (required): `lots` (vested RSU lots to draw from, each `{vestDate: YYYY-MM-DD, shares, costBasisPerShare}`), `current_price` (USD), `divest_fraction` (target share fraction to divest, 0.1 to 1.0), `horizon_years` (1 to 3), `ordinary_income` (USD), `filing_status`, `state_code`.
- Returns: the optimized lot-selling schedule and its total tax, compared against the naive FIFO order, with the per-year and per-lot sales that reach the target divest fraction.

The authoritative request schemas are the OpenAPI spec at <https://optionsahoy.com/openapi.json> and the agent docs at <https://optionsahoy.com/for-agents>.

## Install

```bash
pip install arcade-optionsahoy
```

## Quickstart

The toolkit is a standard Arcade toolkit: load it into a `ToolCatalog` and serve it, or run it in your own MCP server. To inspect the registered tools:

```python
from arcade_tdk import ToolCatalog
import arcade_optionsahoy

catalog = ToolCatalog()
catalog.add_module(arcade_optionsahoy)

print(len(catalog))                 # 8
print([t.definition.name for t in catalog])
```

To run the tools through the Arcade engine, install the [Arcade CLI](https://docs.arcade.dev/home/build-tools/create-a-toolkit) and follow the [Creating a Toolkit](https://docs.arcade.dev/home/build-tools/create-a-toolkit) guide, which loads installed toolkit packages by name. You can also call any tool directly as a plain Python function:

```python
from arcade_optionsahoy import qsbs_check

result = qsbs_check(
    acquisition_date="2018-01-01",
    sale_date="2026-02-01",
    entity_type="us-c-corp",
    acquisition_method="original-issuance",
    asset_category="under-50m",
    industry="tech-software",
    active_business="yes",
    adjusted_basis=10000,
    expected_gain=2000000,
    state_code="CA",
    ordinary_income=250000,
    filing_status="single",
)
print(result["result"]["verdict"])
```

Most endpoints accept forward-looking fields (such as `expected_sale_price` or `volatility`) that the schema marks optional but the API requires at call time; set a covered `ticker` (for example `"NVDA"`) to let the API derive them, or pass explicit values. Omitting both returns a clear 400 explaining which field is needed.

## Runnable example and source

- Runnable example: [`examples/`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/arcade-optionsahoy/examples)
- Source: [`integrations/python/arcade-optionsahoy`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/arcade-optionsahoy)

## Related

Sibling packages wrapping the same calculators:

- [optionsahoy](https://pypi.org/project/optionsahoy/) - plain Python client (no framework)
- [crewai-optionsahoy](https://pypi.org/project/crewai-optionsahoy/) - CrewAI tools
- [optionsahoy-langchain](https://pypi.org/project/optionsahoy-langchain/) - LangChain tools
- [llama-index-tools-optionsahoy](https://pypi.org/project/llama-index-tools-optionsahoy/) - LlamaIndex tools

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
