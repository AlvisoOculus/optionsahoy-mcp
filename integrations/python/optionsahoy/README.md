# optionsahoy

[![PyPI version](https://img.shields.io/pypi/v/optionsahoy.svg)](https://pypi.org/project/optionsahoy/)
[![Python versions](https://img.shields.io/pypi/pyversions/optionsahoy.svg)](https://pypi.org/project/optionsahoy/)
[![License: MIT](https://img.shields.io/pypi/l/optionsahoy.svg)](https://github.com/AlvisoOculus/optionsahoy-mcp/blob/main/LICENSE)

A thin, dependency-light Python client for the OptionsAhoy keyless public REST application programming interface (API). It wraps seven deterministic equity-compensation tax calculators behind one synchronous client. No OptionsAhoy account, no API key, full federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. See the benchmark, updated for the latest models, at https://optionsahoy.com/benchmark. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## Verified

Beyond determinism, the tax math is independently verified, every release: every 2026 federal constant matches its IRS Rev. Proc. 2025-32 value, worked federal cases reproduce to the cent against the independently-maintained [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state tax reproduces to the cent against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/) across CA, NY, NJ, PA, and MA, with the headline answer recomputed live in your browser. Proof, shown beside the public sources: https://optionsahoy.com/verification

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
Optimizes a multi-year incentive stock option (ISO) exercise schedule under the alternative minimum tax (AMT): how many shares to exercise each year so the after-tax outcome is best.
- Inputs (required): `shares` (ISO shares available to exercise), `strike` (exercise price per share, USD), `fmv` (current fair market value per share, USD), `filingStatus` (`single` | `married_joint` | `head_household`), `ordinaryIncome` (annual ordinary income before this exercise, USD), `stateCode` (two-letter US state code, or `DC`), `carryforwardCredit` (existing AMT credit carryforward, USD), `horizon` (planning horizon in years, 1 to 10), `cashReturnRate` (annual return on cash held instead of exercising, decimal), `grantDate` (ISO grant date, YYYY-MM-DD), `hasLeftCompany` (boolean), `terminationDate` (YYYY-MM-DD, or `null` if still employed).
- Optional: `expectedGrowth` (expected annual share-price growth, decimal), `volatility` (annualized, decimal), `volatilityDrag` (0 to 0.99), `ticker` (covered public symbol to source expected return from).
- Returns: `crossoverShares` and `crossoverBargain` (the share count and bargain-element dollar amount at which AMT starts to bite this year); `alreadyInAmt` (boolean, whether the holder is already in AMT before exercising); `stateHasAmt` (boolean); `bargainPerShare` (fair market value minus strike, USD); `effectiveHorizon` (years actually usable, capped by grant expiration); `timing` (key dates: `grantExpiration`, `qdEligibleDate` for the qualifying-disposition long-term threshold, `exerciseWindowClose`, `daysUntilWindowClose`, `windowClosed`, `qdNotYetEligible`); and `schedules` with three strategies `lumpSum`, `evenSplit`, and `optimized`. Each schedule carries `years[]` (per year: `shares` exercised, `bargain`, `regularFederal`, `regularState`, `tmtFederal` and `tmtState` tentative minimum tax, `amtOwedFederal` and `amtOwedState` AMT actually owed above regular tax, `creditRecovered`, `cashTax` total cash tax that year) plus `totalTax`, `creditEarned` and `creditRemaining` (AMT credit generated and still unrecovered), `grossGain`, `federalLTCG` and `stateLTCG` (long-term capital-gains tax at final sale), and `nfv` (net future value of the schedule).

### `nso(...)`
Computes the tax and after-tax proceeds of exercising non-qualified stock options (NSOs), comparing selling at exercise against holding for later long-term capital gains.
- Inputs (required): `shares` (NSO shares to exercise), `strike` (exercise price per share, USD), `currentPrice` (current share price, USD), `ordinaryIncome` (annual ordinary income before this exercise, USD), `filingStatus` (`single` | `married_joint` | `head_household`), `stateCode` (two-letter, or `DC`), `stillEmployed` (boolean; payroll taxes differ once separated), `holdYears` (years held after exercise, at least 1), `holdFunding` (`sell-to-cover` | `cash`; how the exercise is funded).
- Optional: `expectedSalePrice` (USD), `haircut` (risk haircut on expected upside, 0 to 1), `volatility` (decimal), `expectedMarketReturn` (decimal), `ticker` (covered symbol to source expected return).
- Returns: `exercise` (`bargainElement` ordinary income at exercise, plus `federal`, `state`, `socialSecurity`, `medicare`, `additionalMedicare` taxes, `total`, and `netCashSellAll` cash kept if you sell every share at exercise); `bracketJump` (`fromRate`, `toRate`, `thresholdAtJump`: the marginal-rate jump this exercise triggers); `hold` (the hold-and-sell-later path: `sharesRetained`, `expectedGain`, `ltcgTotal` long-term capital-gains tax at sale, `afterTaxProceedsAtSale`, `netAtYearN` net wealth at the end of the hold); `sellNowInvest` (the alternative of selling now and investing the proceeds: `netCashAtY0`, `marketGain`, `netAtYearN`); `holdMinusCashless` (the dollar difference between holding and the sell-now path, positive favors holding).

### `rsu_sell_vs_hold(...)`
Compares selling vested restricted stock units (RSUs) at vest against holding them, on an after-tax, risk-adjusted basis.
- Inputs (required): `shares` (vested RSU shares), `currentPrice` (USD), `ordinaryIncome` (annual ordinary income, USD), `filingStatus` (`single` | `married_joint` | `head_household`), `stateCode` (two-letter, or `DC`), `stillEmployed` (boolean), `holdYears` (years to hold, 0.25 to 5).
- Optional: `expectedSalePrice` (USD), `haircut` (0 to 1), `volatility` (decimal), `expectedMarketReturn` (decimal), `ticker` (covered symbol).
- Returns: `vest` (taxes due at vest: `vestValue` ordinary income recognized, `federal`, `state`, `medicare`, `total`, `netCashAtVest`, and `federalWithheldAtVest` the typical flat withholding); `bracketJump` (`fromRate`, `toRate`, `thresholdAtJump`); `hold` (`sharesRetained`, `expectedGain`, `capGainTotal` capital-gains tax at sale, `isLongTerm` boolean, `netAtYearN` net wealth from holding); `sellNowInvest` (`netCashAtY0`, `marketGain`, `netAtYearN` from selling at vest and investing); `holdMinusSell` (dollar difference, positive favors holding).

### `concentration(...)`
Quantifies single-stock concentration risk and compares the after-tax cost of three responses: sell down, hold, or hedge.
- Inputs (required): `positionValue` (current market value of the position, USD), `costBasis` (total cost basis, USD), `acquisitionDate` (earliest lot, YYYY-MM-DD; sets the one-year long-term threshold), `sector` (one of `tech_software`, `semiconductors`, `consumer_cyclical`, `consumer_defensive`, `financials`, `healthcare_biotech`, `energy`, `industrials`, `communication`, `broad_market`; sets default volatility), `stateCode` (two-letter, or `DC`), `filingStatus` (`single` | `married_joint` | `head_household`), `ordinaryIncome` (USD), `totalAssets` (whole investable portfolio including this position, USD).
- Optional: `expectedPositionReturn` (decimal) and `expectedMarketReturn` (decimal), or `ticker` (covered symbol to derive both); `volatility` (decimal), `volatilityDrag` (0 to 0.99), `hedgeChoice` (`{kind: put|collar, protectionLevel, tenorYears, upsideCapPct}`).
- Returns: `concentration` (position divided by totalAssets, 0 to 1); `riskBand` (a label: `Low` | `Moderate` | `Concentrated` | `Highly concentrated` | `Extreme`); `isLongTermToday` (boolean), `longTermDate` and `daysUntilLongTerm` (when the position reaches long-term treatment); `lossExposure[]` (dollar loss and resulting concentration at 30/50/70 percent drops: `drop`, `dollarLoss`, `newConcentration`); `waitForLtInsight` (a string nudge to wait for long-term rates, or `null`); `schedule[]` (after-tax sell-down plans, each `planKey`/`planLabel`, `yearlySales`, `totalTax`, `endOfHorizonWealth`, `savingsVsLumpSum`, `wealthByYear`); `hedging` (put or collar `strike`, `putPrice`, `sigma`, `riskFreeRate`, present when `hedgeChoice` is given); `sectorContextLine` and `advisorBenchmarkLine` (human-readable summary strings).

### `protective_put(...)`
Prices a protective put and a zero-cost collar for a stock position at a chosen downside-protection level and tenor.
- Inputs (required): `positionValue` (market value to hedge, USD), `sector` (one of `tech_software`, `semiconductors`, `consumer_cyclical`, `consumer_defensive`, `financials`, `healthcare_biotech`, `energy`, `industrials`, `communication`, `broad_market`; sets default volatility), `protectionLevel` (downside protected as a fraction, 0.05 to 0.5), `tenorYears` (hedge tenor in years, at least 0.25).
- Optional: `volatility` (annualized, decimal), `expectedReturn` (decimal), `tickerLabel` (display label for the symbol).
- Returns: `inputs` (the resolved inputs including the volatility used); `riskFreeRate` and `realWorldDrift` (rates used to price); `barePut` (the put alone: `strike`, `premium`, `annualCost`, `annualCostPct`, `maxLoss`, `coveredLossAtBadYear`); `collar` (put financed by selling a call: `putStrike`, `callStrike`, `netPremium`, `maxLoss`, `upsideCap` and `upsideCapPct` the gain you give up, `isZeroCost` boolean); `payoffTable[]` (profit and loss at each drawdown: `drawdownPct`, `barePutPnl`, `collarPnl`, `unhedgedPnl`); `payoffRange` (`lowerPct`, `upperPct`); `recommended` (`bare-put` | `collar` | `none`).

### `qsbs(...)`
Checks qualified small business stock (QSBS) Section 1202 eligibility and computes the resulting federal capital-gains exclusion.
- Inputs (required): `acquisitionDate` and `saleDate` (YYYY-MM-DD; the gap sets the holding period), `entityType` (`us-c-corp` | `other`), `acquisitionMethod` (`original-issuance` | `gift-or-inheritance` | `secondary` | `unsure`), `assetCategory` (issuer gross assets at issuance: `under-50m` | `50m-to-75m` | `over-75m` | `unsure`), `industry` (`tech-software` | `manufacturing` | `biotech-research` | `retail-wholesale` | `health-services` | `law` | `engineering` | `architecture` | `accounting-actuarial` | `consulting` | `finance` | `farming` | `extraction` | `hospitality` | `performing-arts` | `other-services` | `unsure`), `activeBusiness` (`yes` | `no` | `unsure`), `adjustedBasis` (USD), `expectedGain` (USD), `stateCode` (two-letter, or `DC`), `ordinaryIncome` (USD), `filingStatus` (`single` | `married_joint` | `head_household`).
- Returns: `verdict` (`qualifies` | `partial` | `does-not-qualify` and similar); `exclusionPercent` (fraction of gain excluded, 0 to 1); `perIssuerCap`, `tenXBasisCap` (ten-times-basis cap), and `applicableCap` (the binding cap, USD); `excludableGain` and `taxableGain` (USD); `federalTaxSaved` (USD); `stateConforms` (`full` | `partial` | `none`) and `stateNote` (explanation string); `holdingYears`; `yearsUntilFullExclusion`; `era` (which Section 1202 ruleset applies, for example `pre-obbba`); `tests[]` (each eligibility test: `id`, `label`, `status` `pass` | `fail` | `warn`, `detail`).

### `equity_funding(...)`
Plans which equity lots to sell, and when, to fund a cash goal by a target date at the least after-tax cost, accounting for holding-period thresholds and shortfall risk.
- Inputs (required): `targetAfterTax` (after-tax cash goal to raise, USD), `targetDate` (when the cash is needed, YYYY-MM-DD), `ordinaryIncome` (USD), `filingStatus` (`single` | `married_joint` | `head_household`), `stateCode` (two-letter, or `DC`), plus the holdings as either `stacks` (preferred: a list of stacks, each with `currentPrice` and a `lots` list of `{shares, costBasisPerShare, acquisitionDate, vestDate?}`, optional per-stack `ticker`, `expectedAnnualGrowth`, `volatility`) or the legacy `lots` plus a single `currentPrice`.
- Optional: `expectedAnnualGrowth` (decimal), `cashInterestRate` (decimal), `riskToleranceShortfall` (acceptable probability of shortfall, 0 to 1), `defaultVolatility` (decimal), `today` (override for the current date, YYYY-MM-DD).
- Returns: four named plans `recommended`, `lockInNow`, `balanced`, `holdForGrowth`, plus `frontier[]` (the full risk/return frontier), and the echoed `targetAfterTax`, `targetDateISO`, `appliedRiskTolerance`. Each plan carries `planKey`/`planLabel`, `wealthAtTarget` (projected net wealth at the target date), `totalTax`, `shortfallProbability` (chance of missing the goal), and a `plan` with `feasible` (boolean), `totalAfterTaxAchieved`, `totalSharesSold`, `totalGrossProceeds`, `totalTaxes` (`federal`, `state`, `niit`, `total`), `schedule` (per-year sales with per-lot `shares`, `grossProceeds`, `gainAmount`, `isLongTerm`, `federalTax`, `stateTax`, `niit`, `netCash`), `comparison` (savings versus selling everything in the target year), and `remainingShares`/`remainingPositionValue` (what is left unsold).

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
