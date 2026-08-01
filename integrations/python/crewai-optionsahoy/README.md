# crewai-optionsahoy

[![PyPI version](https://img.shields.io/pypi/v/crewai-optionsahoy.svg)](https://pypi.org/project/crewai-optionsahoy/)
[![Python versions](https://img.shields.io/pypi/pyversions/crewai-optionsahoy.svg)](https://pypi.org/project/crewai-optionsahoy/)
[![License: MIT](https://img.shields.io/pypi/l/crewai-optionsahoy.svg)](https://github.com/AlvisoOculus/optionsahoy-mcp/blob/main/LICENSE)

CrewAI tools for the OptionsAhoy equity-compensation calculators. One `crewai.tools.BaseTool` per OptionsAhoy REST endpoint, built on the keyless [`optionsahoy`](https://pypi.org/project/optionsahoy/) client. No OptionsAhoy account, no application programming interface (API) key, relevant federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. See the benchmark, updated for the latest models, at https://optionsahoy.com/benchmark. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## Verified

Beyond determinism, the tax math is independently verified, every release: every 2026 federal constant matches its IRS Rev. Proc. 2025-32 value, worked federal cases reproduce to the cent against the independently-maintained [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state tax reproduces to the cent against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/) across CA, NY, NJ, PA, and MA, with the headline answer recomputed live in your browser. Proof, shown beside the public sources: https://optionsahoy.com/verification

## What it provides

`get_optionsahoy_tools()` returns eight CrewAI `BaseTool`s, each with a pydantic `args_schema` mirroring its endpoint:

- `optionsahoy_amt_iso_optimize` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `optionsahoy_nso_calculate` - non-qualified stock option (NSO) exercise tax, sell-at-exercise versus hold
- `optionsahoy_rsu_sell_vs_hold` - restricted stock unit (RSU) sell at vest versus hold for long-term capital gains
- `optionsahoy_concentration_analyze` - single-stock concentration risk and the after-tax cost of diversifying
- `optionsahoy_protective_put_price` - protective put, zero-cost collar, and put spread pricing
- `optionsahoy_qsbs_check` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `optionsahoy_equity_funding_plan` - multi-year plan to fund a cash goal from equity by a target date
- `optionsahoy_rsu_lot_optimize` - which vested RSU lots to sell, and when, to divest a target fraction at the lowest tax

Coverage spans the relevant federal tax code plus all 50 states and DC. The adapter pulls in the keyless `optionsahoy` client automatically. No API key is read, stored, or sent anywhere.

## Tools: inputs and outputs

Each tool's `args_schema` lists the required parameters below; every tool also accepts optional forward-looking fields (such as `expectedSalePrice`, `volatility`, `expectedMarketReturn`) and, where noted, a convenience `ticker` so the API can derive forward-looking inputs from that symbol. Returns are the top-level fields of the response, wrapped as `{"ok": true, "result": {...}}`; the fields below are those of `result`.

### `optionsahoy_amt_iso_optimize`
Optimizes a multi-year incentive stock option (ISO) exercise schedule under the alternative minimum tax (AMT): how many shares to exercise each year so the after-tax outcome is best.
- Inputs (required): `shares` (ISO shares available to exercise), `strike` (exercise price per share, USD), `fmv` (current fair market value per share, USD), `filingStatus` (`single` | `married_joint` | `head_household`), `ordinaryIncome` (annual ordinary income before this exercise, USD), `stateCode` (two-letter US state code, or `DC`), `carryforwardCredit` (existing AMT credit carryforward, USD), `horizon` (planning horizon in years, 1 to 10), `grantDate` (ISO grant date, YYYY-MM-DD), `hasLeftCompany` (boolean), `terminationDate` (YYYY-MM-DD, or `null` if still employed).
- Optional: `cashReturnRate` (annual after-tax return on idle cash, decimal; defaults to 0.04 when omitted), `expectedGrowth` (expected annual share-price growth, decimal), `volatility` (annualized, decimal), `volatilityDrag` (0 to 0.99), `ticker` (covered public symbol to source expected return from).
- Returns: `crossoverShares` and `crossoverBargain` (the share count and bargain-element dollar amount at which AMT starts to bite this year); `alreadyInAmt` (boolean, whether the holder is already in AMT before exercising); `stateHasAmt` (boolean); `bargainPerShare` (fair market value minus strike, USD); `effectiveHorizon` (years actually usable, capped by grant expiration); `timing` (key dates: `grantExpiration`, `qdEligibleDate` for the qualifying-disposition long-term threshold, `exerciseWindowClose`, `daysUntilWindowClose`, `windowClosed`, `qdNotYetEligible`); and `schedules` with three strategies `lumpSum`, `evenSplit`, and `optimized`. Each schedule carries `years[]` (per year: `shares` exercised, `bargain`, `regularFederal`, `regularState`, `tmtFederal` and `tmtState` tentative minimum tax, `amtOwedFederal` and `amtOwedState` AMT actually owed above regular tax, `creditRecovered`, `cashTax` total cash tax that year) plus `totalTax`, `creditEarned` and `creditRemaining` (AMT credit generated and still unrecovered), `grossGain`, `federalLTCG` and `stateLTCG` (long-term capital-gains tax at final sale), and `nfv` (net future value of the schedule).

### `optionsahoy_nso_calculate`
Computes the tax and after-tax proceeds of exercising non-qualified stock options (NSOs), comparing selling at exercise against holding for later long-term capital gains.
- Inputs (required): `shares` (NSO shares to exercise), `strike` (exercise price per share, USD), `currentPrice` (current share price, USD), `ordinaryIncome` (annual ordinary income before this exercise, USD), `filingStatus` (`single` | `married_joint` | `head_household`), `stateCode` (two-letter, or `DC`), `stillEmployed` (boolean; payroll taxes differ once separated), `holdYears` (years held after exercise, at least 1), `holdFunding` (`sell-to-cover` | `cash`; how the exercise is funded).
- Optional: `expectedSalePrice` (USD), `haircut` (risk haircut on expected upside, 0 to 1), `volatility` (decimal), `expectedMarketReturn` (decimal), `ticker` (covered symbol to source expected return).
- Returns: `exercise` (`bargainElement` ordinary income at exercise, plus `federal`, `state`, `socialSecurity`, `medicare`, `additionalMedicare` taxes, `total`, and `netCashSellAll` cash kept if you sell every share at exercise); `bracketJump` (`fromRate`, `toRate`, `thresholdAtJump`: the marginal-rate jump this exercise triggers); `hold` (the hold-and-sell-later path: `sharesRetained`, `expectedGain`, `ltcgTotal` long-term capital-gains tax at sale, `afterTaxProceedsAtSale`, `netAtYearN` net wealth at the end of the hold); `sellNowInvest` (the alternative of selling now and investing the proceeds: `netCashAtY0`, `marketGain`, `netAtYearN`); `holdMinusCashless` (the dollar difference between holding and the sell-now path, positive favors holding).

### `optionsahoy_rsu_sell_vs_hold`
Compares selling vested restricted stock units (RSUs) at vest against holding them, on an after-tax, risk-adjusted basis.
- Inputs (required): `shares` (vested RSU shares), `currentPrice` (USD), `ordinaryIncome` (annual ordinary income, USD), `filingStatus` (`single` | `married_joint` | `head_household`), `stateCode` (two-letter, or `DC`), `stillEmployed` (boolean), `holdYears` (years to hold, 0.25 to 5).
- Optional: `expectedSalePrice` (USD), `haircut` (0 to 1), `volatility` (decimal), `expectedMarketReturn` (decimal), `ticker` (covered symbol).
- Returns: `vest` (taxes due at vest: `vestValue` ordinary income recognized, `federal`, `state`, `medicare`, `total`, `netCashAtVest`, and `federalWithheldAtVest` the typical flat withholding); `bracketJump` (`fromRate`, `toRate`, `thresholdAtJump`); `hold` (`sharesRetained`, `expectedGain`, `capGainTotal` capital-gains tax at sale, `isLongTerm` boolean, `netAtYearN` net wealth from holding); `sellNowInvest` (`netCashAtY0`, `marketGain`, `netAtYearN` from selling at vest and investing); `holdMinusSell` (dollar difference, positive favors holding).

### `optionsahoy_concentration_analyze`
Quantifies single-stock concentration risk and compares the after-tax cost of three responses: sell down, hold, or hedge.
- Inputs (required): `positionValue` (current market value of the position, USD), `costBasis` (total cost basis, USD), `acquisitionDate` (earliest lot, YYYY-MM-DD; sets the one-year long-term threshold), `sector` (one of `tech_software`, `semiconductors`, `consumer_cyclical`, `consumer_defensive`, `financials`, `healthcare_biotech`, `energy`, `industrials`, `communication`, `broad_market`; sets default volatility), `stateCode` (two-letter, or `DC`), `filingStatus` (`single` | `married_joint` | `head_household`), `ordinaryIncome` (USD), `totalAssets` (whole investable portfolio including this position, USD).
- Optional: `expectedPositionReturn` (decimal) and `expectedMarketReturn` (decimal), or `ticker` (covered symbol to derive both); `volatility` (decimal), `volatilityDrag` (0 to 0.99), `hedgeChoice` (`{kind: put|collar, protectionLevel, tenorYears, upsideCapPct}`).
- Returns: `concentration` (position divided by totalAssets, 0 to 1); `riskBand` (a label: `Low` | `Moderate` | `Concentrated` | `Highly concentrated` | `Extreme`); `isLongTermToday` (boolean), `longTermDate` and `daysUntilLongTerm` (when the position reaches long-term treatment); `lossExposure[]` (dollar loss and resulting concentration at 30/50/70 percent drops: `drop`, `dollarLoss`, `newConcentration`); `waitForLtInsight` (a string nudge to wait for long-term rates, or `null`); `schedule[]` (after-tax sell-down plans, each `planKey`/`planLabel`, `yearlySales`, `totalTax`, `endOfHorizonWealth`, `savingsVsLumpSum`, `wealthByYear`); `hedging` (put or collar `strike`, `putPrice`, `sigma`, `riskFreeRate`, present when `hedgeChoice` is given); `sectorContextLine` and `advisorBenchmarkLine` (human-readable summary strings).

### `optionsahoy_protective_put_price`
Prices a protective put, a zero-cost collar, and a put spread for a stock position at a chosen downside-protection level and tenor. The put spread finances the same floor with a short put instead of a short call, so it is cheaper than the bare put and needs no shares to write calls against (it works on unexercised employee options a collar cannot cover); protection stops at the short strike and losses resume below it.
- Inputs (required): `positionValue` (market value to hedge, USD), `sector` (one of `tech_software`, `semiconductors`, `consumer_cyclical`, `consumer_defensive`, `financials`, `healthcare_biotech`, `energy`, `industrials`, `communication`, `broad_market`; sets default volatility), `protectionLevel` (downside protected as a fraction, 0.05 to 0.5), `tenorYears` (hedge tenor in years, at least 0.25).
- Optional: `volatility` (annualized, decimal), `expectedReturn` (decimal), `spreadRiskLevel` (put spread floor breach risk, 0.01 to 0.2; presets 0.20 / 0.10 / 0.05 / 0.01, i.e. 1 in 5 / 10 / 20 / 100, off-preset snaps to the nearest; affects only the `putSpread` block; default 0.10), `tickerLabel` (display label for the symbol).
- Returns: `inputs` (the resolved inputs including the volatility used); `riskFreeRate` and `realWorldDrift` (rates used to price); `barePut` (the put alone: `strike`, `premium`, `annualCost`, `annualCostPct`, `maxLoss`, `coveredLossAtBadYear`); `collar` (put financed by selling a call: `putStrike`, `callStrike`, `netPremium`, `maxLoss`, `upsideCap` and `upsideCapPct` the gain you give up, `isZeroCost` boolean); `putSpread` (long put financed by a short put at a lower strike: `longStrike`, `shortStrike`, `netPremium`, `bandWidth`, `maxLossInBand`, `savingsPct` versus the bare put, `riskLevel` and `breachProbability` for the floor, `available` boolean); `payoffTable[]` (profit and loss at each drawdown: `drawdownPct`, `barePutPnl`, `collarPnl`, `unhedgedPnl`); `payoffRange` (`lowerPct`, `upperPct`); `recommended` (`bare-put` | `collar` | `put-spread` | `none`).

### `optionsahoy_qsbs_check`
Checks qualified small business stock (QSBS) Section 1202 eligibility and computes the resulting federal capital-gains exclusion.
- Inputs (required): `acquisitionDate` and `saleDate` (YYYY-MM-DD; the gap sets the holding period), `entityType` (`us-c-corp` | `other`), `acquisitionMethod` (`original-issuance` | `gift-or-inheritance` | `secondary` | `unsure`), `assetCategory` (issuer gross assets at issuance: `under-50m` | `50m-to-75m` | `over-75m` | `unsure`), `industry` (`tech-software` | `manufacturing` | `biotech-research` | `retail-wholesale` | `health-services` | `law` | `engineering` | `architecture` | `accounting-actuarial` | `consulting` | `finance` | `farming` | `extraction` | `hospitality` | `performing-arts` | `other-services` | `unsure`), `activeBusiness` (`yes` | `no` | `unsure`), `adjustedBasis` (USD), `expectedGain` (USD), `stateCode` (two-letter, or `DC`), `ordinaryIncome` (USD), `filingStatus` (`single` | `married_joint` | `head_household`).
- Returns: `verdict` (`qualifies` | `partial` | `does-not-qualify` and similar); `exclusionPercent` (fraction of gain excluded, 0 to 1); `perIssuerCap`, `tenXBasisCap` (ten-times-basis cap), and `applicableCap` (the binding cap, USD); `excludableGain` and `taxableGain` (USD); `federalTaxSaved` (USD); `stateConforms` (`full` | `partial` | `none`) and `stateNote` (explanation string); `holdingYears`; `yearsUntilFullExclusion`; `era` (which Section 1202 ruleset applies, for example `pre-obbba`); `tests[]` (each eligibility test: `id`, `label`, `status` `pass` | `fail` | `warn`, `detail`).

### `optionsahoy_equity_funding_plan`
Plans which equity lots to sell, and when, to fund a cash goal by a target date at the least after-tax cost, accounting for holding-period thresholds and shortfall risk.
- Inputs (required): `targetAfterTax` (after-tax cash goal to raise, USD), `targetDate` (when the cash is needed, YYYY-MM-DD), `ordinaryIncome` (USD), `filingStatus` (`single` | `married_joint` | `head_household`), `stateCode` (two-letter, or `DC`), plus the holdings as either `stacks` (preferred: a list of stacks, each with `currentPrice` and a `lots` list of `{shares, costBasisPerShare, acquisitionDate, vestDate?}`, optional per-stack `ticker`, `expectedAnnualGrowth`, `volatility`) or the legacy `lots` plus a single `currentPrice`.
- Optional: `expectedAnnualGrowth` (decimal), `cashInterestRate` (decimal), `riskToleranceShortfall` (acceptable probability of shortfall, 0 to 1), `defaultVolatility` (decimal).
- Returns: four named plans `recommended`, `lockInNow`, `balanced`, `holdForGrowth`, plus `frontier[]` (the full risk/return frontier), and the echoed `targetAfterTax`, `targetDateISO`, `appliedRiskTolerance`. Each plan carries `planKey`/`planLabel`, `wealthAtTarget` (projected net wealth at the target date), `totalTax`, `shortfallProbability` (chance of missing the goal), and a `plan` with `feasible` (boolean), `totalAfterTaxAchieved`, `totalSharesSold`, `totalGrossProceeds`, `totalTaxes` (`federal`, `state`, `niit`, `total`), `schedule` (per-year sales with per-lot `shares`, `grossProceeds`, `gainAmount`, `isLongTerm`, `federalTax`, `stateTax`, `niit`, `netCash`), `comparison` (savings versus selling everything in the target year), and `remainingShares`/`remainingPositionValue` (what is left unsold).

### `optionsahoy_rsu_lot_optimize`
Chooses which vested restricted stock unit (RSU) lots to sell, and when, to divest a target share fraction at the lowest tax, using specific-lot identification, long-term deferral, and multi-year bracket spreading, versus a first-in-first-out (FIFO) sell order.
- Inputs (required): `lots` (vested RSU lots to draw from, each `{vestDate: YYYY-MM-DD, shares, costBasisPerShare}`), `currentPrice` (current share price, USD), `divestFraction` (target share fraction to divest, decimal 0.1 to 1.0), `horizonYears` (planning horizon in years, 1 to 3), `ordinaryIncome` (annual ordinary income, USD), `filingStatus` (`single` | `married_joint` | `head_household`), `stateCode` (two-letter US state code, or `DC`).
- Returns: the optimized lot-selling schedule and its total tax, compared against the naive FIFO order, with the per-year and per-lot sales that reach the target divest fraction.

To see the full typed input schema for any tool, call `tools[0].args_schema.model_json_schema()` (substitute the tool you want). The authoritative request schemas are the OpenAPI spec at <https://optionsahoy.com/openapi.json> and the agent docs at <https://optionsahoy.com/for-agents>.

## Install

```bash
pip install crewai-optionsahoy
```

## Quickstart

Equip a CrewAI agent with the tools and run a crew. CrewAI reads the model from the standard provider environment variables (for example `OPENAI_API_KEY`):

```python
from crewai import Agent, Crew, Process, Task

from crewai_optionsahoy import get_optionsahoy_tools

tools = get_optionsahoy_tools()

advisor = Agent(
    role="Equity-compensation analyst",
    goal="Answer equity-compensation tax questions using the OptionsAhoy tools.",
    backstory=(
        "You analyze stock-option and equity tax questions for technology workers. "
        "You always call the OptionsAhoy tools for exact numbers instead of "
        "estimating the tax math yourself."
    ),
    tools=tools,
    llm="gpt-4o-mini",
    verbose=True,
)

task = Task(
    description=(
        "A founder acquired original-issuance stock in a US C-corporation on "
        "2018-01-01 for an adjusted basis of $10000, in the tech-software industry, "
        "issuer under $50M in gross assets at issuance and meeting the active-business "
        "test. They plan to sell on 2026-02-01 for an expected gain of $2,000,000. "
        "They file single in California with $250000 of ordinary income. Does this "
        "qualify for QSBS, and how much gain is excludable? "
        "Use the optionsahoy_qsbs_check tool."
    ),
    expected_output="Whether the position qualifies and the dollar amount of excludable gain.",
    agent=advisor,
)

crew = Crew(agents=[advisor], tasks=[task], process=Process.sequential, verbose=True)
print(crew.kickoff())
```

Pass your own configured client with `get_optionsahoy_tools(client=OptionsAhoyClient(...))`.

Most endpoints accept forward-looking fields (such as `expectedSalePrice` or `volatility`) that the schema marks optional but the API requires at call time; set a covered `ticker` (for example `"NVDA"`) to let the API derive them, or pass explicit values. Omitting both returns a clear 400 explaining which field is needed.

## Runnable example and source

- Runnable example: [`examples/`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/crewai-optionsahoy/examples)
- Source: [`integrations/python/crewai-optionsahoy`](https://github.com/AlvisoOculus/optionsahoy-mcp/tree/main/integrations/python/crewai-optionsahoy)

## Related

Sibling packages wrapping the same calculators:

- [optionsahoy](https://pypi.org/project/optionsahoy/) - plain Python client (no framework)
- [optionsahoy-langchain](https://pypi.org/project/optionsahoy-langchain/) - LangChain tools
- [llama-index-tools-optionsahoy](https://pypi.org/project/llama-index-tools-optionsahoy/) - LlamaIndex tools

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
