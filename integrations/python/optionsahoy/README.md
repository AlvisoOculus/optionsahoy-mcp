# optionsahoy

A thin, dependency-light Python client for the OptionsAhoy keyless public REST application programming interface (API). It wraps seven deterministic equity-compensation tax calculators behind one synchronous client. No OptionsAhoy account, no API key, full federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## What it provides

Seven calculators, each a method on `OptionsAhoyClient`:

- `amt_iso(...)` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `nso(...)` - non-qualified stock option (NSO) exercise tax and after-tax proceeds, sell-at-exercise versus hold
- `rsu_sell_vs_hold(...)` - restricted stock unit (RSU) vest decision, sell at vest versus hold for long-term capital gains
- `concentration(...)` - single-stock concentration risk and the after-tax cost of diversifying
- `protective_put(...)` - protective put and zero-cost collar pricing
- `qsbs(...)` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `equity_funding(...)` - multi-year plan to fund a cash goal from equity by a target date

Coverage spans the full federal tax code (ordinary brackets, long-term capital gains, AMT with credit recovery, FICA, the net investment income tax) plus all 50 states and DC. The only runtime dependency is [httpx](https://www.python-httpx.org/). No API key is read, stored, or sent anywhere.

## Tools: inputs and outputs

Each method takes keyword arguments. The required parameters are listed below; every method also accepts optional forward-looking fields (such as `expectedSalePrice`, `volatility`, `expectedMarketReturn`) and, where noted, a convenience `ticker` so the API can derive forward-looking inputs from that symbol. Returns are the top-level fields of the response; responses are wrapped as `{"ok": true, "result": {...}}` and the fields below are those of `result`.

### `amt_iso(...)`
Multi-year incentive stock option (ISO) exercise optimizer under the alternative minimum tax (AMT).
**Inputs (required):** `shares: int`, `strike: float`, `fmv: float`, `filingStatus: str`, `ordinaryIncome: float`, `stateCode: str`, `carryforwardCredit: float`, `horizon: int`, `cashReturnRate: float`, `grantDate: str`, `hasLeftCompany: bool`, `terminationDate: str | None`. Optional: `expectedGrowth`, `volatility`, `volatilityDrag`, `ticker`.
**Returns:** `crossoverShares`, `crossoverBargain`, `alreadyInAmt`, `stateHasAmt`, `bargainPerShare`, `timing`, `effectiveHorizon`, and `schedules` (`lumpSum`, `evenSplit`, `optimized`), each carrying per-year `years[]` (`shares`, `bargain`, `regularFederal`, `regularState`, `tmtFederal`, `tmtState`, `amtOwedFederal`, `amtOwedState`, `creditRecovered`, `cashTax`) plus `totalTax`, `creditEarned`, `creditRemaining`, `grossGain`, `federalLTCG`, `stateLTCG`, `nfv`.

### `nso(...)`
Tax and after-tax proceeds of exercising non-qualified stock options (NSOs), sell-at-exercise versus hold.
**Inputs (required):** `shares: int`, `strike: float`, `currentPrice: float`, `ordinaryIncome: float`, `filingStatus: str`, `stateCode: str`, `stillEmployed: bool`, `holdYears: float`, `holdFunding: str` (`sell-to-cover` or `cash`). Optional: `expectedSalePrice`, `haircut`, `volatility`, `expectedMarketReturn`, `ticker`.
**Returns:** `exercise` (`bargainElement`, `federal`, `state`, `socialSecurity`, `medicare`, `additionalMedicare`, `total`, `netCashSellAll`), `bracketJump` (`fromRate`, `toRate`, `thresholdAtJump`), `hold` (`sharesRetained`, `expectedGain`, `ltcgTotal`, `afterTaxProceedsAtSale`, `netAtYearN`), `sellNowInvest` (`netCashAtY0`, `marketGain`, `netAtYearN`), `holdMinusCashless`.

### `rsu_sell_vs_hold(...)`
Sell vested restricted stock units (RSUs) at vest versus hold, on an after-tax, risk-adjusted basis.
**Inputs (required):** `shares: int`, `currentPrice: float`, `ordinaryIncome: float`, `filingStatus: str`, `stateCode: str`, `stillEmployed: bool`, `holdYears: float`. Optional: `expectedSalePrice`, `haircut`, `volatility`, `expectedMarketReturn`, `ticker`.
**Returns:** `vest` (`vestValue`, `federal`, `state`, `medicare`, `total`, `netCashAtVest`, `federalWithheldAtVest`), `bracketJump`, `hold` (`sharesRetained`, `expectedGain`, `capGainTotal`, `isLongTerm`, `netAtYearN`), `sellNowInvest` (`netCashAtY0`, `marketGain`, `netAtYearN`), `holdMinusSell`.

### `concentration(...)`
Concentrated single-stock position and the after-tax cost of diversifying.
**Inputs (required):** `positionValue: float`, `costBasis: float`, `acquisitionDate: str`, `sector: str`, `stateCode: str`, `filingStatus: str`, `ordinaryIncome: float`, `totalAssets: float`. Optional: `expectedPositionReturn`, `expectedMarketReturn`, `volatility`, `volatilityDrag`, `hedgeChoice`, `ticker`.
**Returns:** `concentration`, `riskBand`, `isLongTermToday`, `longTermDate`, `daysUntilLongTerm`, `lossExposure[]` (`drop`, `dollarLoss`, `newConcentration`), `waitForLtInsight`, `schedule[]` (`planKey`, `planLabel`, `yearlySales`, `totalTax`, `endOfHorizonWealth`, `savingsVsLumpSum`, `wealthByYear`), `hedging`, `sectorContextLine`, `advisorBenchmarkLine`.

### `protective_put(...)`
Price a protective put and a zero-cost collar for a stock position.
**Inputs (required):** `positionValue: float`, `sector: str`, `protectionLevel: float` (0.05 to 0.5), `tenorYears: float`. Optional: `volatility`, `expectedReturn`, `tickerLabel`.
**Returns:** `inputs`, `riskFreeRate`, `realWorldDrift`, `barePut` (`strike`, `premium`, `annualCost`, `annualCostPct`, `maxLoss`, `coveredLossAtBadYear`), `collar` (`putStrike`, `callStrike`, `netPremium`, `maxLoss`, `upsideCap`, `upsideCapPct`, `isZeroCost`), `payoffTable[]` (`drawdownPct`, `barePutPnl`, `collarPnl`, `unhedgedPnl`), `payoffRange`, `recommended`.

### `qsbs(...)`
Qualified small business stock (QSBS) Section 1202 eligibility and exclusion.
**Inputs (required):** `acquisitionDate: str`, `saleDate: str`, `entityType: str`, `acquisitionMethod: str`, `assetCategory: str`, `industry: str`, `activeBusiness: str`, `adjustedBasis: float`, `expectedGain: float`, `stateCode: str`, `ordinaryIncome: float`, `filingStatus: str`.
**Returns:** `verdict`, `exclusionPercent`, `perIssuerCap`, `tenXBasisCap`, `applicableCap`, `excludableGain`, `taxableGain`, `federalTaxSaved`, `stateConforms`, `stateNote`, `holdingYears`, `yearsUntilFullExclusion`, `era`, `tests[]` (`id`, `label`, `status`, `detail`).

### `equity_funding(...)`
Plan which equity lots to sell, and when, to fund a cash goal by a target date.
**Inputs (required):** `targetAfterTax: float`, `targetDate: str`, `ordinaryIncome: float`, `filingStatus: str`, `stateCode: str`, plus either `stacks` (preferred; a list of stacks, each with `currentPrice` and a `lots` list) or the legacy `lots` plus `currentPrice`. Optional: `expectedAnnualGrowth`, `cashInterestRate`, `riskToleranceShortfall`, `defaultVolatility`, `today`.
**Returns:** `recommended`, `lockInNow`, `balanced`, `holdForGrowth`, `frontier[]`, `targetAfterTax`, `targetDateISO`, `appliedRiskTolerance`. Each plan (for example `recommended`) carries `wealthAtTarget`, `totalTax`, `shortfallProbability`, `lockInFraction`, and a `plan` with `feasible`, `totalAfterTaxAchieved`, `totalSharesSold`, `totalTaxes`, `schedule`, and `remainingPositionValue`.

To see the full typed signature for any method, read the client source: [`optionsahoy/client.py`](https://github.com/AlvisoOculus/optionsahoy-mcp/blob/main/integrations/python/optionsahoy/optionsahoy/client.py). The authoritative request schemas are the OpenAPI spec at <https://optionsahoy.com/openapi.json> and the agent docs at <https://optionsahoy.com/for-agents>.

## Install

```bash
pip install optionsahoy
```

## Quickstart

```python
from optionsahoy import OptionsAhoyClient, OptionsAhoyError

client = OptionsAhoyClient()  # base_url defaults to https://optionsahoy.com

try:
    # QSBS: can this founder exclude gain on a planned sale?
    result = client.qsbs(
        acquisitionDate="2018-01-01",
        saleDate="2026-02-01",
        entityType="us-c-corp",
        acquisitionMethod="original-issuance",
        assetCategory="under-50m",
        industry="tech-software",
        activeBusiness="yes",
        adjustedBasis=10000,
        expectedGain=2000000,
        stateCode="CA",
        ordinaryIncome=250000,
        filingStatus="single",
    )
    print(result)
except OptionsAhoyError as err:
    print(err.status_code, err.payload)
```

Field names, types, and required-ness mirror the published OpenAPI schema at <https://optionsahoy.com/openapi.json> one for one; this client does not invent or rename fields. Optional fields left unset are not sent.

### Forward-looking inputs

Some endpoints (for example `nso` and `rsu_sell_vs_hold`) accept forward-looking fields such as `expectedSalePrice` and `volatility` that the OpenAPI schema marks optional. At runtime the API requires you to supply these explicitly, or to set a covered `ticker` (for example `"NVDA"`) so the API can derive them from that symbol's trailing data. Do not invent these values; pass what the user provides or a ticker. Omitting both returns a clear 400 explaining which field is needed.

## Runnable example and source

- Runnable example: [`examples/`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/optionsahoy/examples)
- Source: [`integrations/python/optionsahoy`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/optionsahoy)

## Related

Agent-framework adapters that wrap this same client behind each framework's native tool interface:

- [optionsahoy-langchain](https://pypi.org/project/optionsahoy-langchain/) - LangChain tools
- [llama-index-tools-optionsahoy](https://pypi.org/project/llama-index-tools-optionsahoy/) - LlamaIndex tools
- [crewai-optionsahoy](https://pypi.org/project/crewai-optionsahoy/) - CrewAI tools

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
