# optionsahoy-ai-sdk

[![npm version](https://img.shields.io/npm/v/optionsahoy-ai-sdk.svg)](https://www.npmjs.com/package/optionsahoy-ai-sdk)
[![License: MIT](https://img.shields.io/npm/l/optionsahoy-ai-sdk.svg)](https://github.com/AlvisoOculus/optionsahoy-mcp/blob/main/LICENSE)

Vercel AI SDK tools for the OptionsAhoy equity-compensation calculators. One `tool()` per OptionsAhoy REST endpoint, each with a `zod` parameters schema and an `execute` that calls the keyless REST API. No OptionsAhoy account, no application programming interface (API) key, relevant federal tax code plus all 50 states and the District of Columbia (DC).

## Why not just ask the model?

We benchmarked five frontier large language models (LLMs), 3 runs each, 15 trials total, on the same multi-year incentive stock option (ISO) exercise problem. Every trial overshot the true after-tax outcome, by 2x to 20x. See the benchmark, updated for the latest models, at https://optionsahoy.com/benchmark. Multi-year scheduling has a search space larger than an LLM can reason through in-context; these tools return the verifiable answer instead.

Raw responses and scoring: [llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark). Full write-up: [But can it do taxes though?](https://hackernoon.com/but-can-it-do-taxes-though-why-you-shouldnt-trust-chatbots-with-tax-optimization-math).

## Verified

Beyond determinism, the tax math is independently verified, every release: every 2026 federal constant matches its IRS Rev. Proc. 2025-32 value, worked federal cases reproduce to the cent against the independently-maintained [PSL Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator), and state tax reproduces to the cent against [OpenTaxSolver](https://opentaxsolver.sourceforge.net/) across CA, NY, NJ, PA, and MA, with the headline answer recomputed live in your browser. Proof, shown beside the public sources: https://optionsahoy.com/verification

## What it provides

`createOptionsAhoyTools()` returns an object keyed by the eight tool names, each a Vercel AI SDK tool with a `zod` `parameters` schema mirroring its endpoint:

- `amt_iso_optimize` - multi-year ISO exercise optimizer under the alternative minimum tax (AMT)
- `nso_calculate` - non-qualified stock option (NSO) exercise tax, sell-at-exercise versus hold
- `rsu_sell_vs_hold` - restricted stock unit (RSU) sell at vest versus hold for long-term capital gains
- `concentration_analyze` - single-stock concentration risk and the after-tax cost of diversifying
- `protective_put_price` - protective put, zero-cost collar, and put spread pricing
- `qsbs_check` - qualified small business stock (QSBS) Section 1202 eligibility and exclusion
- `equity_funding_plan` - multi-year plan to fund a cash goal from equity by a target date
- `rsu_lot_optimize` - which vested RSU lots to sell, and when, to divest a target share fraction at the lowest tax

Each `execute` POSTs to `https://optionsahoy.com/api/v1/<slug>` and returns the parsed `result`. No API key is read, stored, or sent anywhere. Results are independent calculations; integrated multi-year, multi-position optimization is available in the OptionsAhoy beta at https://optionsahoy.com/beta.

## Install

```bash
npm install optionsahoy-ai-sdk ai zod
```

`ai` (the Vercel AI SDK) and `zod` are peer dependencies. This package targets AI SDK v4 (the `tool({ description, parameters, execute })` shape).

## Quickstart

Spread the tools into `generateText` (or `streamText`) alongside any tool-calling model. The model picks the right calculator, and the SDK runs the `execute` and feeds the result back:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai'; // npm i @ai-sdk/openai; set OPENAI_API_KEY
import { createOptionsAhoyTools } from 'optionsahoy-ai-sdk';

const tools = createOptionsAhoyTools();

const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  tools,
  maxSteps: 5, // let the model call a tool, then answer from the result
  system:
    'You are an equity-compensation assistant. Use the OptionsAhoy tools to ' +
    'compute exact tax-aware answers; do not estimate the math yourself.',
  prompt:
    'I have 8000 ISOs at a $3 strike, current fair market value $40, granted ' +
    '2022-03-01, still employed. I file single in California with $250000 of ' +
    'ordinary income, no AMT carryforward, 4% cash return, 5-year horizon. ' +
    'How many shares should I exercise each year?',
});

console.log(text);
```

Prefer a single tool? Pick it off the returned object:

```ts
import { createOptionsAhoyTools } from 'optionsahoy-ai-sdk';

const { qsbs_check } = createOptionsAhoyTools();
// use `qsbs_check` on its own in a `tools: { qsbs_check }` map
```

The default set is keyless and points at `https://optionsahoy.com`. To route through a different origin or inject a custom `fetch` (for tests or a proxy):

```ts
const tools = createOptionsAhoyTools({ baseURL: 'https://optionsahoy.com', fetch: myFetch });
```

## Inputs

Each tool's `parameters` schema lists the required fields; every tool also accepts optional forward-looking fields. The five growth- and volatility-bearing tools (`amt_iso_optimize`, `nso_calculate`, `rsu_sell_vs_hold`, `concentration_analyze`, `protective_put_price`) accept an optional `ticker` (for example `"NVDA"`) so the API can derive the expected return, sale price, and volatility from a covered symbol. Pass explicit values or a covered `ticker`; omitting both returns a clear 400 explaining which field is needed.

- `amt_iso_optimize` - required: `shares`, `strike`, `fmv`, `filingStatus`, `ordinaryIncome`, `stateCode`, `carryforwardCredit`, `horizon`, `grantDate`, `hasLeftCompany`. Optional: `cashReturnRate` (defaults to 0.04), `terminationDate`, `expectedGrowth`, `volatility`, `volatilityDrag`, `ticker`.
- `nso_calculate` - required: `shares`, `strike`, `currentPrice`, `ordinaryIncome`, `filingStatus`, `stateCode`, `stillEmployed`, `holdYears`, `holdFunding`. Optional: `expectedSalePrice`, `volatility`, `expectedMarketReturn`, `ticker`.
- `rsu_sell_vs_hold` - required: `shares`, `currentPrice`, `ordinaryIncome`, `filingStatus`, `stateCode`, `stillEmployed`, `holdYears`. Optional: `expectedSalePrice`, `volatility`, `expectedMarketReturn`, `ticker`.
- `concentration_analyze` - required: `positionValue`, `costBasis`, `acquisitionDate`, `sector`, `stateCode`, `filingStatus`, `ordinaryIncome`, `totalAssets`. Optional: `expectedPositionReturn`, `expectedMarketReturn`, `volatility`, `volatilityDrag`, `ticker`, `hedgeChoice`.
- `protective_put_price` - required: `positionValue`, `sector`, `protectionLevel`, `tenorYears`. Optional: `volatility`, `expectedReturn`, `ticker`, `tickerLabel`, `spreadRiskLevel`.
- `qsbs_check` - required: `acquisitionDate`, `saleDate`, `entityType`, `acquisitionMethod`, `assetCategory`, `industry`, `activeBusiness`, `adjustedBasis`, `expectedGain`, `stateCode`, `ordinaryIncome`, `filingStatus`.
- `equity_funding_plan` - required: `targetAfterTax`, `targetDate`, `ordinaryIncome`, `filingStatus`, `stateCode`, plus holdings as either `stacks` or the legacy `lots` + `currentPrice`. Optional: `expectedAnnualGrowth`, `cashInterestRate`, `riskToleranceShortfall`, `defaultVolatility`.
- `rsu_lot_optimize` - required: `lots` (each with `vestDate`, `shares`, `costBasisPerShare`), `currentPrice`, `divestFraction`, `horizonYears`, `ordinaryIncome`, `filingStatus`, `stateCode`.

The authoritative request schemas are the OpenAPI spec at <https://optionsahoy.com/openapi.json> and the agent docs at <https://optionsahoy.com/for-agents>. The individual `zod` schemas are also exported (`amtIsoParameters`, `nsoParameters`, and so on) if you want to reuse or extend them.

## Related

Sibling packages wrapping the same calculators:

- [optionsahoy-langchain](https://pypi.org/project/optionsahoy-langchain/) - LangChain tools (Python)
- [llama-index-tools-optionsahoy](https://pypi.org/project/llama-index-tools-optionsahoy/) - LlamaIndex tools (Python)
- [crewai-optionsahoy](https://pypi.org/project/crewai-optionsahoy/) - CrewAI tools (Python)
- [optionsahoy](https://pypi.org/project/optionsahoy/) - plain Python client (no framework)

Other surfaces for the same calculators:

- Hosted Model Context Protocol (MCP) server: <https://optionsahoy.com/mcp>
- Agent integration docs: <https://optionsahoy.com/for-agents>
- Free in-browser calculators: <https://optionsahoy.com/tools>

Built by [AlphaLatitude Inc.](https://alphalatitude.com), the company behind [OptionsAhoy](https://optionsahoy.com).
