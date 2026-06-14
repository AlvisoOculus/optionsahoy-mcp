# optionsahoy-langchain

LangChain tools for the OptionsAhoy equity-compensation calculators. One `StructuredTool` per OptionsAhoy REST endpoint, built on the keyless [`optionsahoy`](https://pypi.org/project/optionsahoy/) client. No OptionsAhoy account, no application programming interface (API) key, full federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## What it provides

`get_optionsahoy_tools()` returns seven `StructuredTool`s, each with a pydantic `args_schema` mirroring its endpoint:

- `optionsahoy_amt_iso_optimize` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `optionsahoy_nso_calculate` - non-qualified stock option (NSO) exercise tax, sell-at-exercise versus hold
- `optionsahoy_rsu_sell_vs_hold` - restricted stock unit (RSU) sell at vest versus hold for long-term capital gains
- `optionsahoy_concentration_analyze` - single-stock concentration risk and the after-tax cost of diversifying
- `optionsahoy_protective_put_price` - protective put and zero-cost collar pricing
- `optionsahoy_qsbs_check` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `optionsahoy_equity_funding_plan` - multi-year plan to fund a cash goal from equity by a target date

Coverage spans the full federal tax code plus all 50 states and DC. The adapter pulls in the keyless `optionsahoy` client automatically. No API key is read, stored, or sent anywhere.

## Tools: inputs and outputs

Each tool's `args_schema` lists the required parameters below; every tool also accepts optional forward-looking fields (such as `expectedSalePrice`, `volatility`, `expectedMarketReturn`) and, where noted, a convenience `ticker` so the API can derive forward-looking inputs from that symbol. Returns are the top-level fields of the response, wrapped as `{"ok": true, "result": {...}}`; the fields below are those of `result`.

### `optionsahoy_amt_iso_optimize`
Multi-year incentive stock option (ISO) exercise optimizer under the alternative minimum tax (AMT).
**Inputs (required):** `shares: int`, `strike: float`, `fmv: float`, `filingStatus: str`, `ordinaryIncome: float`, `stateCode: str`, `carryforwardCredit: float`, `horizon: int`, `cashReturnRate: float`, `grantDate: str`, `hasLeftCompany: bool`, `terminationDate: str | None`. Optional: `expectedGrowth`, `volatility`, `volatilityDrag`, `ticker`.
**Returns:** `crossoverShares`, `crossoverBargain`, `alreadyInAmt`, `stateHasAmt`, `bargainPerShare`, `timing`, `effectiveHorizon`, and `schedules` (`lumpSum`, `evenSplit`, `optimized`), each carrying per-year `years[]` (`shares`, `bargain`, `regularFederal`, `regularState`, `tmtFederal`, `tmtState`, `amtOwedFederal`, `amtOwedState`, `creditRecovered`, `cashTax`) plus `totalTax`, `creditEarned`, `creditRemaining`, `grossGain`, `federalLTCG`, `stateLTCG`, `nfv`.

### `optionsahoy_nso_calculate`
Tax and after-tax proceeds of exercising non-qualified stock options (NSOs), sell-at-exercise versus hold.
**Inputs (required):** `shares: int`, `strike: float`, `currentPrice: float`, `ordinaryIncome: float`, `filingStatus: str`, `stateCode: str`, `stillEmployed: bool`, `holdYears: float`, `holdFunding: str` (`sell-to-cover` or `cash`). Optional: `expectedSalePrice`, `haircut`, `volatility`, `expectedMarketReturn`, `ticker`.
**Returns:** `exercise` (`bargainElement`, `federal`, `state`, `socialSecurity`, `medicare`, `additionalMedicare`, `total`, `netCashSellAll`), `bracketJump` (`fromRate`, `toRate`, `thresholdAtJump`), `hold` (`sharesRetained`, `expectedGain`, `ltcgTotal`, `afterTaxProceedsAtSale`, `netAtYearN`), `sellNowInvest` (`netCashAtY0`, `marketGain`, `netAtYearN`), `holdMinusCashless`.

### `optionsahoy_rsu_sell_vs_hold`
Sell vested restricted stock units (RSUs) at vest versus hold, on an after-tax, risk-adjusted basis.
**Inputs (required):** `shares: int`, `currentPrice: float`, `ordinaryIncome: float`, `filingStatus: str`, `stateCode: str`, `stillEmployed: bool`, `holdYears: float`. Optional: `expectedSalePrice`, `haircut`, `volatility`, `expectedMarketReturn`, `ticker`.
**Returns:** `vest` (`vestValue`, `federal`, `state`, `medicare`, `total`, `netCashAtVest`, `federalWithheldAtVest`), `bracketJump`, `hold` (`sharesRetained`, `expectedGain`, `capGainTotal`, `isLongTerm`, `netAtYearN`), `sellNowInvest` (`netCashAtY0`, `marketGain`, `netAtYearN`), `holdMinusSell`.

### `optionsahoy_concentration_analyze`
Concentrated single-stock position and the after-tax cost of diversifying.
**Inputs (required):** `positionValue: float`, `costBasis: float`, `acquisitionDate: str`, `sector: str`, `stateCode: str`, `filingStatus: str`, `ordinaryIncome: float`, `totalAssets: float`. Optional: `expectedPositionReturn`, `expectedMarketReturn`, `volatility`, `volatilityDrag`, `hedgeChoice`, `ticker`.
**Returns:** `concentration`, `riskBand`, `isLongTermToday`, `longTermDate`, `daysUntilLongTerm`, `lossExposure[]` (`drop`, `dollarLoss`, `newConcentration`), `waitForLtInsight`, `schedule[]` (`planKey`, `planLabel`, `yearlySales`, `totalTax`, `endOfHorizonWealth`, `savingsVsLumpSum`, `wealthByYear`), `hedging`, `sectorContextLine`, `advisorBenchmarkLine`.

### `optionsahoy_protective_put_price`
Price a protective put and a zero-cost collar for a stock position.
**Inputs (required):** `positionValue: float`, `sector: str`, `protectionLevel: float` (0.05 to 0.5), `tenorYears: float`. Optional: `volatility`, `expectedReturn`, `tickerLabel`.
**Returns:** `inputs`, `riskFreeRate`, `realWorldDrift`, `barePut` (`strike`, `premium`, `annualCost`, `annualCostPct`, `maxLoss`, `coveredLossAtBadYear`), `collar` (`putStrike`, `callStrike`, `netPremium`, `maxLoss`, `upsideCap`, `upsideCapPct`, `isZeroCost`), `payoffTable[]` (`drawdownPct`, `barePutPnl`, `collarPnl`, `unhedgedPnl`), `payoffRange`, `recommended`.

### `optionsahoy_qsbs_check`
Qualified small business stock (QSBS) Section 1202 eligibility and exclusion.
**Inputs (required):** `acquisitionDate: str`, `saleDate: str`, `entityType: str`, `acquisitionMethod: str`, `assetCategory: str`, `industry: str`, `activeBusiness: str`, `adjustedBasis: float`, `expectedGain: float`, `stateCode: str`, `ordinaryIncome: float`, `filingStatus: str`.
**Returns:** `verdict`, `exclusionPercent`, `perIssuerCap`, `tenXBasisCap`, `applicableCap`, `excludableGain`, `taxableGain`, `federalTaxSaved`, `stateConforms`, `stateNote`, `holdingYears`, `yearsUntilFullExclusion`, `era`, `tests[]` (`id`, `label`, `status`, `detail`).

### `optionsahoy_equity_funding_plan`
Plan which equity lots to sell, and when, to fund a cash goal by a target date.
**Inputs (required):** `targetAfterTax: float`, `targetDate: str`, `ordinaryIncome: float`, `filingStatus: str`, `stateCode: str`, plus either `stacks` (preferred; a list of stacks, each with `currentPrice` and a `lots` list) or the legacy `lots` plus `currentPrice`. Optional: `expectedAnnualGrowth`, `cashInterestRate`, `riskToleranceShortfall`, `defaultVolatility`, `today`.
**Returns:** `recommended`, `lockInNow`, `balanced`, `holdForGrowth`, `frontier[]`, `targetAfterTax`, `targetDateISO`, `appliedRiskTolerance`. Each plan (for example `recommended`) carries `wealthAtTarget`, `totalTax`, `shortfallProbability`, `lockInFraction`, and a `plan` with `feasible`, `totalAfterTaxAchieved`, `totalSharesSold`, `totalTaxes`, `schedule`, and `remainingPositionValue`.

To see the full typed input schema for any tool, call `tools[0].args_schema.model_json_schema()` (substitute the tool you want). The authoritative request schemas are the OpenAPI spec at <https://optionsahoy.com/openapi.json> and the agent docs at <https://optionsahoy.com/for-agents>.

## Install

```bash
pip install optionsahoy-langchain
```

## Quickstart

Bind the tools to any tool-calling chat model and run a minimal tool-calling loop:

```python
import os

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI  # pip install langchain-openai; set OPENAI_API_KEY

from langchain_optionsahoy import get_optionsahoy_tools

tools = get_optionsahoy_tools()
tools_by_name = {t.name: t for t in tools}

model = ChatOpenAI(model="gpt-4o-mini", temperature=0)
model_with_tools = model.bind_tools(tools)

messages = [
    SystemMessage(content=(
        "You are an equity-compensation assistant. Use the OptionsAhoy tools to "
        "compute exact tax-aware answers; do not estimate the math yourself."
    )),
    HumanMessage(content=(
        "I have 8000 ISOs at a $3 strike, current fair market value $40, granted "
        "2022-03-01, still employed. I file single in California with $250000 of "
        "ordinary income, no AMT carryforward, 4% cash return, 5-year horizon. "
        "How many shares should I exercise each year? "
        "Use the optionsahoy_amt_iso_optimize tool."
    )),
]

# Minimal tool-calling loop: invoke the model, run any tools it requests,
# append results as ToolMessages, repeat until it gives a final answer.
for _ in range(5):
    ai: AIMessage = model_with_tools.invoke(messages)
    messages.append(ai)
    if not ai.tool_calls:
        print(ai.content)
        break
    for call in ai.tool_calls:
        result = tools_by_name[call["name"]].invoke(call["args"])
        messages.append(ToolMessage(content=str(result), tool_call_id=call["id"]))
```

Pass your own configured client with `get_optionsahoy_tools(client=OptionsAhoyClient(...))`.

The seven endpoints accept forward-looking fields (such as `expectedSalePrice` or `volatility`) that the schema marks optional but the API requires at call time; set a covered `ticker` (for example `"NVDA"`) to let the API derive them, or pass explicit values. Omitting both returns a clear 400 explaining which field is needed.

## Runnable example and source

- Runnable example: [`examples/`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/optionsahoy-langchain/examples)
- Source: [`integrations/python/optionsahoy-langchain`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/optionsahoy-langchain)

## Related

Sibling packages wrapping the same calculators:

- [optionsahoy](https://pypi.org/project/optionsahoy/) - plain Python client (no framework)
- [llama-index-tools-optionsahoy](https://pypi.org/project/llama-index-tools-optionsahoy/) - LlamaIndex tools
- [crewai-optionsahoy](https://pypi.org/project/crewai-optionsahoy/) - CrewAI tools

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
