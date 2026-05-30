// AlphaLatitude Inc. © 2026
//
// MCP tool definitions. Each tool wraps one calculator: name, description,
// inputSchema (used by tools/list), and handler (invoked by tools/call).
// The MCP server (functions/mcp.ts) dispatches to handler by tool name.
//
// Input schemas mirror the OpenAPI 3.1 spec at /openapi.json. They are
// inlined here rather than imported from openapi.json so the function
// bundle is self-contained at deploy time.

import { computeAmtIso } from '../../lib/calc/amtIso';
import { computeNsoResult } from '../../lib/calc/nso';
import { computeRsuResult } from '../../lib/calc/rsu';
import { calculate as computeConcentration } from '../../lib/calc/concentration';
import { calculateProtectivePut } from '../../lib/calc/protectivePut';
import { evaluateQsbs } from '../../lib/calc/qsbs';

import { FILING_STATUSES } from './api';
import {
  parseAmtIsoInput,
  parseNsoInput,
  parseRsuInput,
  parseConcentrationInput,
  parseProtectivePutInput,
  parseQsbsInput,
} from './calc-parsers';

export type McpToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  idempotentHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  handler: (args: unknown) => unknown;
};

// All six tools are pure deterministic calculators with no side effects.
const CALC_HINTS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// Shared inputSchema fragments.
const FILING_SCHEMA = { type: 'string', enum: [...FILING_STATUSES] };
const STATE_SCHEMA = { type: 'string', pattern: '^[A-Z]{2}$' };
const SECTOR_SCHEMA = {
  type: 'string',
  enum: [
    'tech_software',
    'semiconductors',
    'consumer_cyclical',
    'consumer_defensive',
    'financials',
    'healthcare_biotech',
    'energy',
    'industrials',
    'communication',
    'broad_market',
  ],
};
const ISO_DATE = { type: 'string', format: 'date' };

// Shared optional ticker field — the four growth-bearing calculators (ISO,
// NSO, RSU, concentration) accept it as an alternative to passing explicit
// expected-return / sale-price values. Resolved against the trailing-CAGR
// table at lib/data/trailing-returns.json (~90 covered public-stock symbols,
// refreshed daily).
const TICKER_SCHEMA = {
  type: 'string',
  description:
    'Optional public-stock symbol (e.g. "NVDA", "AAPL"). When set, the tool substitutes the ticker\'s trailing CAGR for any unsupplied expected-return / sale-price field instead of requiring the caller to invent one. ~90 symbols covered; unknown tickers fall through to "required field" errors so the model knows to ask the user.',
};

// Boilerplate appended to every growth-bearing tool's description. Tells the
// invoking model how to handle required fields whose only honest sources are
// the user message or a recognized ticker — never the model itself.
const STRICT_INPUT_NOTE =
  ' IMPORTANT: every field listed in `required` must come from the user\'s message OR be derivable from an optional `ticker`. The model invoking this tool MUST NOT invent a value for any required field. If the user did not supply it and no ticker resolves it, ask the user.';

// Same idea for tools without ticker-derivable shortcuts (qsbs_check,
// protective_put_price). Tells the model to ask for missing required fields
// rather than guessing — and to pass `unsure` rather than a definite value
// when the schema offers that enum option.
const STRICT_INPUT_NOTE_NO_TICKER =
  ' IMPORTANT: every field listed in `required` must come from the user\'s message. The model invoking this tool MUST NOT invent a value for any required field. If the user did not supply it, ask the user. For enum fields that accept `unsure`, pass `unsure` when the user does not know; do not guess yes/no.';

// Vol input shared by amt_iso_optimize, nso_calculate, rsu_sell_vs_hold.
// concentration_analyze defines its own version because it also uses sigma
// for Black-Scholes hedge pricing (dual purpose).
const VOLATILITY_SCHEMA = {
  type: 'number',
  minimum: 0,
  description:
    'Annualized volatility (sigma) of the stock as a decimal (0.72 = 72%). Pass the user-supplied volatility directly; the tool computes the horizon-cumulative drag internally. The model MUST NOT compute drag itself — the correct formula is horizon-dependent and most models get it wrong. If the user does not supply a volatility number, ASK them.',
};

export const TOOLS: McpTool[] = [
  {
    name: 'amt_iso_optimize',
    annotations: { title: 'ISO/AMT Exercise Optimization', ...CALC_HINTS },
    description:
      'Multi-year Incentive Stock Option (ISO) exercise schedule that maximizes after-tax Net Final Value (NFV) at the planning horizon. NFV is the after-all-tax cash equivalent of the position at year `horizon`, summing exercised shares (held to LTCG) plus the time-valued tax stream paid along the way; the optimizer chooses the per-year share allocation that lands the highest NFV across all feasible schedules. When the user asks for "maximum value", "best schedule", or "optimal exercise plan", report NFV (in dollars) as the primary headline — `schedules.optimized.nfv` is the recommended plan; compare it against `schedules.lumpSum.nfv` and `schedules.evenSplit.nfv` to show the value delta from the optimization. Use this tool for ISO planning; for NSO grants use `nso_calculate`, for RSUs at vest use `rsu_sell_vs_hold`, for §1202 QSBS qualification use `qsbs_check`. Models AMT credit recovery across future years, grant-expiration timing, and the post-termination exercise window. Pure deterministic computation: no network access, no PII retention; federal + 50-state tax tables and AMT brackets are compiled in. The optimizer searches the full feasible share-per-year space (exhaustive, not heuristic). Returns a top-level object with keys: `schedules` (object containing `lumpSum`, `evenSplit`, and `optimized` — each {nfv, federalLTCG, stateLTCG, amtPremiumFV, grossGain}), `crossoverShares` (max shares that can be exercised in year 1 before tentative AMT exceeds regular tax), `crossoverBargain`, `alreadyInAmt` (boolean), `timing` (grant expiration / qualifying disposition / 90-day window flags), `stateHasAmt`, `bargainPerShare`, `effectiveHorizon`, and `departedRecommendation` when applicable. Example call: {shares: 10000, strike: 2, fmv: 200, expectedGrowth: 0.15, volatility: 0.5, filingStatus: "married_joint", ordinaryIncome: 400000, stateCode: "CA", carryforwardCredit: 0, horizon: 4, cashReturnRate: 0.05, grantDate: "2022-01-15", hasLeftCompany: false, terminationDate: null}.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'strike', 'fmv', 'filingStatus',
        'ordinaryIncome', 'stateCode', 'carryforwardCredit', 'horizon', 'cashReturnRate',
        'grantDate', 'hasLeftCompany', 'terminationDate',
      ],
      properties: {
        shares: {
          type: 'integer',
          minimum: 1,
          description:
            'Total Incentive Stock Option (ISO) shares available to exercise across the planning horizon.',
        },
        strike: {
          type: 'number',
          minimum: 0,
          description: 'Strike price per share, USD.',
        },
        fmv: {
          type: 'number',
          minimum: 0,
          description:
            'Current fair market value per share, USD. Anchors year-1 of the growth path; future years compound from here using expectedGrowth and volatilityDrag.',
        },
        expectedGrowth: {
          type: 'number',
          description:
            'Annual expected stock growth as a decimal (0.10 = 10%). Required unless `ticker` resolves it from trailing CAGR.',
        },
        ticker: TICKER_SCHEMA,
        volatility: VOLATILITY_SCHEMA,
        filingStatus: {
          ...FILING_SCHEMA,
          description:
            'Federal filing status. Drives the ordinary-bracket walk, the AMT exemption tier ($90,100 single / $140,200 MFJ for 2026), and the AMT exemption phaseout start ($500,000 single / $1,000,000 MFJ).',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description:
            'Annual W-2 ordinary income before this exercise, USD. Baseline for the bracket walk and the AMT exemption phaseout.',
        },
        stateCode: {
          ...STATE_SCHEMA,
          description:
            'Two-letter US state code (e.g. CA, NY, TX). Drives state ordinary brackets, state long-term capital gains (LTCG) treatment, and state AMT (CA, CO, CT, MN).',
        },
        carryforwardCredit: {
          type: 'number',
          minimum: 0,
          description:
            'Existing federal AMT credit (Minimum Tax Credit, Form 8801) carryforward from prior tax years, USD. Recoverable in future years where regular federal tax exceeds tentative minimum tax.',
        },
        horizon: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description:
            'Planning horizon in years (1..10). The optimizer searches all feasible per-year share allocations across this many years.',
        },
        cashReturnRate: {
          type: 'number',
          description:
            'Annual after-tax return on idle cash (decimal), used to time-value the cash-tax stream. 0.05 = 5% (~short-Treasury yield). Ask the user (e.g. "what after-tax yield should I use for idle cash, e.g. ~5% for short-term Treasury?"). At 0 the math collapses to a nominal sum.',
        },
        grantDate: {
          ...ISO_DATE,
          description:
            'ISO grant date (YYYY-MM-DD). Drives the 10-year statutory grant expiration (IRC §422) and the 2-year qualifying-disposition threshold from grant.',
        },
        hasLeftCompany: {
          type: 'boolean',
          description:
            'True if the user has separated from the company. Activates the 90-day post-termination ISO exercise window measured from terminationDate.',
        },
        terminationDate: {
          oneOf: [ISO_DATE, { type: 'null' }],
          description:
            'Separation date (YYYY-MM-DD) when hasLeftCompany=true; null when still employed. Together with hasLeftCompany, drives the 90-day exercise window deadline.',
        },
      },
    },
    handler: (args) => computeAmtIso(parseAmtIsoInput(args)),
  },
  {
    name: 'nso_calculate',
    annotations: { title: 'NSO Sell-vs-Hold Analysis', ...CALC_HINTS },
    description:
      'After-tax payout on a non-qualified stock option (NSO) exercise: federal, state, and FICA (Social Security + Medicare + Additional Medicare), comparing sell-at-exercise vs hold-for-long-term-capital-gains over the chosen horizon. Use for NSOs; for ISOs use `amt_iso_optimize`, for RSUs use `rsu_sell_vs_hold`. Deterministic, offline; tax tables compiled in. Optional `ticker` resolves `expectedSalePrice` from a bundled trailing-CAGR snapshot.\n\nReturns a top-level object with these keys:\n- `exercise`: bargainElement, federal, state, socialSecurity, medicare, additionalMedicare, total, netCashSellAll, sharesSoldToCover, sharesRetained.\n- `hold`: expectedGain, capGainFederal, capGainState, capGainTotal, isLongTerm at end of holdYears (LTCG triggers at holdYears ≥ 1).\n- `sellNowInvest`: counterfactual where shares are sold at exercise and proceeds reinvested at expectedMarketReturn.\n- `holdMinusCashless`: dollar delta between `hold` and `sellNowInvest`.\n- `bracketJump`: fromRate, toRate, thresholdAtJump describing the marginal bracket change at exercise.\n\nExample call: {shares: 5000, strike: 10, currentPrice: 50, ordinaryIncome: 180000, filingStatus: "single", stateCode: "CA", stillEmployed: true, holdYears: 2, volatility: 0.3, holdFunding: "cash", ticker: "AAPL"}.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'strike', 'currentPrice', 'ordinaryIncome', 'filingStatus', 'stateCode',
        'stillEmployed', 'holdYears', 'holdFunding',
      ],
      properties: {
        shares: {
          type: 'integer',
          minimum: 1,
          description: 'Non-qualified Stock Option (NSO) shares to exercise.',
        },
        strike: {
          type: 'number',
          minimum: 0,
          description: 'Strike price per share, USD.',
        },
        currentPrice: {
          type: 'number',
          minimum: 0,
          description:
            'Current fair market value per share, USD. The bargain element at exercise is shares × (currentPrice − strike).',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description:
            'Annual W-2 ordinary income before this exercise, USD. Baseline for the bracket walk on the bargain element.',
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description: 'Federal filing status. Drives ordinary brackets and LTCG brackets used at the hold horizon.',
        },
        stateCode: {
          ...STATE_SCHEMA,
          description: 'Two-letter US state code. Drives state ordinary and LTCG treatment.',
        },
        stillEmployed: {
          type: 'boolean',
          description:
            'True if still employed at exercise. FICA (Social Security + Medicare + Additional Medicare) applies only when true.',
        },
        holdYears: {
          type: 'number',
          minimum: 1,
          description:
            'Years to hold after exercise (minimum 1). At ≥1 year, the appreciation since exercise is LTCG; sub-1-year holds are out of scope.',
        },
        expectedSalePrice: {
          type: 'number',
          minimum: 0,
          description:
            'Projected $/share at end of holdYears. Required unless `ticker` resolves it from currentPrice × (1 + trailing CAGR)^holdYears.',
        },
        volatility: VOLATILITY_SCHEMA,
        expectedMarketReturn: {
          type: 'number',
          description:
            'Annual after-tax-proceeds reinvestment rate. Defaults to SPY trailing CAGR for holdYears if omitted.',
        },
        ticker: TICKER_SCHEMA,
        holdFunding: {
          type: 'string',
          enum: ['sell-to-cover', 'cash'],
          description:
            "How the strike cost and exercise tax are funded. 'sell-to-cover' sells enough shares to cover strike + tax (reduces sharesRetained). 'cash' pays from outside the position (full sharesRetained but requires the cashNeededAtExercise field).",
        },
      },
    },
    handler: (args) => computeNsoResult(parseNsoInput(args)),
  },
  {
    name: 'rsu_sell_vs_hold',
    annotations: { title: 'RSU Sell-at-Vest vs Hold', ...CALC_HINTS },
    description:
      'After-tax payout on a Restricted Stock Unit (RSU) vest: federal ordinary income tax, state income tax, FICA (Social Security + Medicare + Additional Medicare), and the gap between mandatory 22% federal supplemental withholding and the user\'s marginal bracket. Use this tool for RSUs at vest; for ISO/AMT planning use `amt_iso_optimize`, for NSO use `nso_calculate`. Compares sell-at-vest vs hold-for-long-term-capital-gains (LTCG) across the chosen horizon, accounting for the 12-month short-term-vs-long-term holding threshold and the optional expected-growth assumption. Pure deterministic computation: no network access; tax tables and the 22% supplemental-withholding rate are compiled in. Returns a top-level object with keys: `vest` (vestValue, federal, state, socialSecurity, medicare, additionalMedicare, total, netCashAtVest, federalWithheldAtVest), `hold` (expectedGain at horizon, capGainFederal/State/Total including NIIT, isLongTerm), `sellNowInvest` (counterfactual: sell at vest and reinvest at expectedMarketReturn), `holdMinusSell` (dollar delta), and `bracketJump` (fromRate, toRate, thresholdAtJump on the vest amount). Example call: {shares: 1000, currentPrice: 100, ordinaryIncome: 200000, filingStatus: "single", stateCode: "CA", stillEmployed: true, holdYears: 2, volatility: 0.3, ticker: "MSFT"}.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'currentPrice', 'ordinaryIncome', 'filingStatus', 'stateCode',
        'stillEmployed', 'holdYears',
      ],
      properties: {
        shares: {
          type: 'integer',
          minimum: 1,
          description: 'Restricted Stock Unit (RSU) shares vesting in this tranche.',
        },
        currentPrice: {
          type: 'number',
          minimum: 0,
          description:
            'Fair market value per share at vest, USD. Also the cost basis on retained shares.',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description: 'Annual W-2 ordinary income before this vest, USD. Baseline for the bracket walk on the vest amount.',
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description: 'Federal filing status.',
        },
        stateCode: {
          ...STATE_SCHEMA,
          description: 'Two-letter US state code.',
        },
        stillEmployed: {
          type: 'boolean',
          description:
            'True if still employed at vest. Drives FICA applicability and whether the 22% supplemental withholding rule applies.',
        },
        holdYears: {
          type: 'number',
          minimum: 0.25,
          maximum: 5,
          description:
            'Years to hold after vest (0.25..5). Below 1 year triggers the short-term capital gains cliff (ordinary rates on appreciation).',
        },
        expectedSalePrice: {
          type: 'number',
          minimum: 0,
          description:
            'Projected $/share at end of holdYears. Required unless `ticker` resolves it from currentPrice × (1 + trailing CAGR)^holdYears.',
        },
        volatility: VOLATILITY_SCHEMA,
        expectedMarketReturn: {
          type: 'number',
          description:
            'Annual after-tax-proceeds reinvestment rate. Defaults to SPY trailing CAGR for holdYears if omitted.',
        },
        ticker: TICKER_SCHEMA,
      },
    },
    handler: (args) => computeRsuResult(parseRsuInput(args)),
  },
  {
    name: 'concentration_analyze',
    annotations: { title: 'Single-Stock Concentration Analysis', ...CALC_HINTS },
    description:
      'Single-stock concentration risk analysis on an existing position. For standalone hedge pricing use `protective_put_price`; for the tax math on the option exercise or RSU vest that created the concentration, route to `amt_iso_optimize` / `nso_calculate` / `rsu_sell_vs_hold` first. Quantifies drawdown exposure at 30/50/70% downside, then compares three after-tax strategies over a three-year horizon (sell-down to target weight, hold, hedge with put or zero-cost collar), accounting for federal LTCG, state tax, the 3.8% Net Investment Income Tax (NIIT), and reinvestment opportunity cost. `totalAssets` (concentrated position + everything else) frames risk relative to the portfolio and MUST come from the user, never inferred. Returns a top-level object with keys: `concentration` (position/totalAssets), `riskBand` (Low / Moderate / Concentrated / Highly concentrated / Extreme), `isLongTermToday`, `longTermDate`, `daysUntilLongTerm`, `lossExposure` ({drop, dollarLoss, newConcentration} for 30/50/70% drops), `waitForLtInsight`, `schedule` (yearly sales with per-year tax), `hedging` (NFV + cost when hedgeChoice provided), `sectorContextLine`, `advisorBenchmarkLine`. Example call: {positionValue: 400000, costBasis: 100000, acquisitionDate: "2022-01-01", sector: "tech_software", stateCode: "CA", filingStatus: "single", ordinaryIncome: 200000, totalAssets: 1200000, volatility: 0.45, ticker: "NVDA"}.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'positionValue', 'costBasis', 'acquisitionDate', 'sector', 'stateCode', 'filingStatus',
        'ordinaryIncome', 'totalAssets',
      ],
      properties: {
        positionValue: {
          type: 'number',
          minimum: 0,
          description: 'Current market value of the concentrated single-stock position, USD.',
        },
        costBasis: {
          type: 'number',
          minimum: 0,
          description:
            'Total cost basis of the position, USD (sum of strikes paid + ordinary-income inclusions on RSU vest / NSO exercise / disqualified ISO).',
        },
        acquisitionDate: {
          ...ISO_DATE,
          description:
            'Earliest acquisition date in the lot (YYYY-MM-DD). Drives the 1-year LTCG threshold and the long-term-vs-short-term tax routing.',
        },
        sector: {
          ...SECTOR_SCHEMA,
          description:
            'Sector tag. Drives the default volatility used in the hedge-cost computation when no explicit volatility is provided. See lib/markets/sector-stats.ts for the per-sector annualVol table; this tool applies IV_OVER_RV_MULTIPLIER (1.20) to the realized vol to approximate implied vol.',
        },
        stateCode: {
          ...STATE_SCHEMA,
          description: 'Two-letter US state code. Drives state LTCG and ordinary brackets.',
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description: 'Federal filing status. Drives LTCG brackets and the NIIT MAGI threshold.',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description: 'Annual W-2 ordinary income before any sales, USD. Baseline for LTCG bracket determination.',
        },
        totalAssets: {
          type: 'number',
          minimum: 0,
          description:
            'Total investable portfolio in dollars (concentrated position + everything else). User-supplied; never inferred. If the user did not state it, ASK.',
        },
        expectedPositionReturn: {
          type: 'number',
          description:
            'Annual expected return on the concentrated stock as a decimal (0.10 = 10%). Required unless `ticker` resolves it from trailing CAGR.',
        },
        expectedMarketReturn: {
          type: 'number',
          description:
            'Annual after-tax-proceeds reinvestment rate. Defaults to SPY trailing CAGR for the 3-year horizon if omitted.',
        },
        ticker: TICKER_SCHEMA,
        volatility: {
          type: 'number',
          minimum: 0,
          description:
            'Annualized volatility (sigma) of the stock as a decimal (0.72 = 72%). Pass the user-supplied volatility directly; the tool uses it both for hedge pricing (as implied vol) and for the 3y horizon drag, computed internally. The model MUST NOT compute drag itself — the correct formula is horizon-dependent and most models get it wrong. If the user does not supply a volatility number, ASK them; only when neither is supplied does hedge pricing fall back to sector_stats.annualVol × 1.20.',
        },
        hedgeChoice: {
          type: 'object',
          required: ['kind', 'protectionLevel', 'tenorYears'],
          description:
            'Optional hedge specification. When provided, adds a hedged scenario to the sell-down-vs-hold comparison and computes the post-tax NFV of the hedged hold. Omit to compare only sell-down vs. hold.',
          properties: {
            kind: {
              type: 'string',
              enum: ['put', 'collar'],
              description:
                "Hedge instrument: 'put' (bare protective put — pay premium for downside protection) or 'collar' (put financed by a short call — caps upside in exchange for lower or zero net premium).",
            },
            protectionLevel: {
              type: 'number',
              minimum: 0.05,
              maximum: 0.5,
              description: 'Put strike chosen as (1 − this fraction) × spot. 0.10 = 10% OTM put. Range 0.05..0.50.',
            },
            tenorYears: {
              type: 'number',
              minimum: 0.25,
              description: 'Option tenor in years. 1 = 12-month; 0.25 = ~90-day.',
            },
            upsideCapPct: {
              type: 'number',
              description:
                'For collars only: optional explicit upside cap as fraction above spot (e.g. 0.20 = 20% cap). Omit to let the tool solve for the cap that makes the collar zero-net-premium.',
            },
          },
        },
      },
    },
    handler: (args) => computeConcentration(parseConcentrationInput(args)),
  },
  {
    name: 'protective_put_price',
    annotations: { title: 'Protective Put / Collar Pricing', ...CALC_HINTS },
    description:
      'Black-Scholes pricing of a protective put or zero-cost collar on a single-stock position. Use for standalone hedge pricing on a single-stock position; for concentration-vs-hedge tax-cost comparison, use `concentration_analyze` with a `hedgeChoice`. Parameter interactions an agent should know: `volatility` omitted falls back to `sector_stats[sector].annualVol × 1.20` (the implied-over-realized vol multiplier); supply an explicit sigma when the user provides one. For collars, omitting `upsideCapPct` lets the tool back-solve the cap that zeros the net premium (truly zero-cost collar); supplying `upsideCapPct` overrides the solver and yields a non-zero net premium when the cap is wider than zero-cost. `tenorYears` drives the risk-free-rate lookup AND the floor-hit / cap-hit probability metrics, so changing tenor shifts every probability output even at fixed strike. `expectedReturn` affects only the probability metrics (real-world drift in the floor-hit / cap-hit calculations); premium math is risk-neutral and ignores it (default 0). `protectionLevel` sets the put strike as `(1 − protectionLevel) × spot`; raising it widens the protected zone but raises premium roughly linearly. Closed-form, deterministic, offline: sector volatility table and risk-free-rate curve compiled in. Reports annualized hedge cost as a percentage of position value, maximum loss with the hedge in place, upside-participation cap (collar only, since the short call offsets the long put premium), and probability of hitting the protection floor over the tenor. Returns a top-level object with keys: `inputs` (echoed canonical input), `riskFreeRate` (used in Black-Scholes), `realWorldDrift` (from expectedReturn), `barePut` (strike, premium, annualCost, annualCostPct, maxLoss, badYearPrice, badYearDropPct, coveredLossAtBadYear, premiumToCoveredRatio, expectedProfit, premiumToExpectedProfitRatio), `collar` (putStrike, callStrike, netPremium, annualCost, annualCostPct, maxLoss, upsideCap, upsideCapPct, isZeroCost, capProbability), `payoffTable`, `payoffRange`, and `recommended` (the better of bare put vs collar given the inputs). Both `barePut` and `collar` blocks are always returned regardless of caller preference; the caller picks. Example call: {positionValue: 400000, sector: "tech_software", protectionLevel: 0.10, tenorYears: 1}.' + STRICT_INPUT_NOTE_NO_TICKER,
    inputSchema: {
      type: 'object',
      required: ['positionValue', 'sector', 'protectionLevel', 'tenorYears'],
      properties: {
        positionValue: {
          type: 'number',
          minimum: 0,
          description:
            'Market value of the underlying single-stock position, USD. Premium and max-loss scale linearly with this.',
        },
        sector: {
          ...SECTOR_SCHEMA,
          description:
            'Sector tag. Drives the default volatility when no explicit `volatility` is supplied. Lookup table is in lib/markets/sector-stats.ts.',
        },
        volatility: {
          type: 'number',
          minimum: 0,
          description:
            'Annualized implied volatility (sigma) of the stock. Defaults to a sector-typical IV when omitted. The model SHOULD NOT invent this. Either pass an explicit value the user gave you, or omit it and let the sector default apply.',
        },
        protectionLevel: {
          type: 'number',
          minimum: 0.05,
          maximum: 0.5,
          description: 'Put strike as (1 − this fraction) × spot. 0.10 = 10% OTM put. Range 0.05..0.50.',
        },
        tenorYears: {
          type: 'number',
          minimum: 0.25,
          description: 'Option tenor in years. 1 = 12-month; 0.25 = ~90-day.',
        },
        expectedReturn: {
          type: 'number',
          description:
            'Annual expected stock return (decimal). Drives risk-neutral drift in the cap-hit / floor-hit probability metrics. Does not affect premium math. Default 0.',
        },
        tickerLabel: {
          type: 'string',
          description: 'Optional display string echoed back in the result. Not used in pricing.',
        },
      },
    },
    handler: (args) => calculateProtectivePut(parseProtectivePutInput(args)),
  },
  {
    name: 'qsbs_check',
    annotations: { title: 'QSBS Qualification Check', ...CALC_HINTS },
    description:
      'Section 1202 Qualified Small Business Stock (QSBS) qualification check. Use this tool for §1202 / QSBS qualification. For AMT timing on the ISO exercise that produced the QSBS holding, use `amt_iso_optimize` first. Parameter interactions an agent should know: `entityType="other"` short-circuits the verdict to `does-not-qualify` regardless of other fields; `acquisitionMethod="secondary"` does the same; `assetCategory="over-75m"` likewise fails immediately. Under `acquisitionMethod="gift-or-inheritance"` the holding period tacks from the original holder, so supply that earlier date as `acquisitionDate` if known. `acquisitionDate` drives era classification independent of holding period: before 2009-02-17 caps exclusion at 50%, 2009-02-17 to 2010-09-27 at 75%, 2010-09-28 through 2025-07-04 reaches 100% after a 5-year hold (pre-OBBBA), and 2025-07-05 onward uses the OBBBA tiered schedule (50% at 3y, 75% at 4y, 100% at 5y). The per-issuer exclusion cap is `max($10M, 10 × adjustedBasis)`; when `expectedGain` exceeds it, the overage is fully taxable and the response surfaces `taxableGain` for that delta. `industry` is the dominant industry (>80% revenue) when the corp operates in multiple. Evaluates the eight statutory tests: domestic C-corporation entity, original-issuance acquisition method, gross assets at issuance (under $50M / $50-75M / over $75M tiered cap), qualified-trade-or-business industry, active-business posture (80% asset use), holding period (3 / 4 / 5-year tiers under OBBBA), adjusted basis, and expected gain at sale. Pure stateless check: no filing, reporting, or IRS lookup happens; the eight tests are evaluated against the bundled OBBBA 2026 rule set and per-state conformity table. Returns a top-level object with keys: `verdict` (qualifies / partial / does-not-qualify), `exclusionPercent` (0..1), `perIssuerCap` and `tenXBasisCap` (the two cap inputs), `applicableCap` (max of the two), `excludableGain`, `taxableGain`, `federalTaxSaved` (LTCG bracket on the excluded gain), `stateConforms` (full / partial / none) and `stateNote` (per-state explanation), `holdingYears`, `yearsUntilFullExclusion`, `era` (pre-2009 / 2009-2010 / pre-obbba / obbba), and `tests` (array of {id, label, status, detail} for each of the eight statutory tests so an agent can show which gate failed). Example call: {acquisitionDate: "2020-01-15", saleDate: "2026-06-01", entityType: "us-c-corp", acquisitionMethod: "original-issuance", assetCategory: "under-50m", industry: "tech-software", activeBusiness: "yes", adjustedBasis: 100000, expectedGain: 5000000, stateCode: "CA", ordinaryIncome: 250000, filingStatus: "single"}.' + STRICT_INPUT_NOTE_NO_TICKER,
    inputSchema: {
      type: 'object',
      required: [
        'acquisitionDate', 'saleDate', 'entityType', 'acquisitionMethod', 'assetCategory',
        'industry', 'activeBusiness', 'adjustedBasis', 'expectedGain', 'stateCode',
        'ordinaryIncome', 'filingStatus',
      ],
      properties: {
        acquisitionDate: {
          ...ISO_DATE,
          description:
            'Date the QSBS shares were acquired (YYYY-MM-DD). Drives the holding-period test and the era classification (50% pre-2009, 75% 2009-2010, 100% 2010-2025-07-04, OBBBA tiered after 2025-07-05).',
        },
        saleDate: {
          ...ISO_DATE,
          description:
            'Planned or actual sale date (YYYY-MM-DD). Together with acquisitionDate determines holdingYears.',
        },
        entityType: {
          type: 'string',
          enum: ['us-c-corp', 'other'],
          description:
            "§1202 Test 1: Type of issuer at the time of acquisition. Only 'us-c-corp' qualifies. S-corps, LLCs, partnerships, and foreign entities fail.",
        },
        acquisitionMethod: {
          type: 'string',
          enum: ['original-issuance', 'gift-or-inheritance', 'secondary', 'unsure'],
          description:
            "§1202 Test 2: How the user obtained the shares. 'original-issuance' (direct from the company) qualifies. 'gift-or-inheritance' tacks the original holder's basis and clock. 'secondary' (bought on a secondary market) does NOT qualify. 'unsure' triggers a partial verdict.",
        },
        assetCategory: {
          type: 'string',
          enum: ['under-50m', '50m-to-75m', 'over-75m', 'unsure'],
          description:
            "§1202 Test 3: Aggregate gross assets of the issuing corporation at the time of issuance. 'under-50m' qualifies pre-OBBBA. '50m-to-75m' qualifies ONLY under OBBBA 2026+ (post-2025-07-05). 'over-75m' never qualifies. 'unsure' returns a partial verdict.",
        },
        industry: {
          type: 'string',
          enum: [
            'tech-software', 'manufacturing', 'biotech-research', 'retail-wholesale',
            'health-services', 'law', 'engineering', 'architecture',
            'accounting-actuarial', 'consulting', 'finance', 'farming',
            'extraction', 'hospitality', 'performing-arts', 'other-services', 'unsure',
          ],
          description:
            '§1202 Test 4: Industry classification of the corporation. Qualified-trade-or-business industries qualify (tech-software, manufacturing, biotech-research, retail-wholesale, hospitality, etc.). Specified service trades or businesses (law, engineering, architecture, accounting-actuarial, consulting, finance, farming, extraction, health-services, performing-arts) generally do NOT qualify.',
        },
        activeBusiness: {
          type: 'string',
          enum: ['yes', 'no', 'unsure'],
          description:
            "§1202 Test 5: Did the corporation use ≥80% of its assets in the active conduct of a qualified trade throughout the holding period? 'yes' qualifies. 'no' fails. 'unsure' returns a partial verdict (user should confirm with their CFO).",
        },
        adjustedBasis: {
          type: 'number',
          minimum: 0,
          description:
            "Adjusted basis of the QSBS shares, USD. Used in the 10× basis cap: the per-issuer exclusion cap is max($10M, 10 × adjustedBasis).",
        },
        expectedGain: {
          type: 'number',
          description:
            'Expected total gain on sale, USD. Compared against the per-issuer exclusion cap to compute excludableGain and taxableGain.',
        },
        stateCode: {
          ...STATE_SCHEMA,
          description:
            'Two-letter US state code. Drives the state-conformity verdict: CA/AL/PA/MS do not conform (full state tax owed); HI/MA partial; NJ 2026-01-01 conformity switch; most others fully conform.',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description: 'Annual W-2 ordinary income, USD. Baseline for the federal LTCG bracket on any taxable gain.',
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description: 'Federal filing status. Drives the LTCG bracket on any non-excluded gain and the NIIT MAGI threshold.',
        },
      },
    },
    handler: (args) => evaluateQsbs(parseQsbsInput(args)),
  },
];
