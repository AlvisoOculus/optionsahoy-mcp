// AlphaLatitude Inc. © 2026
//
// MCP tool definitions. Each tool wraps one calculator: name, description,
// inputSchema (used by tools/list), and handler (invoked by tools/call).
// The MCP server (functions/mcp.ts) dispatches to handler by tool name.
//
// Input schemas mirror the OpenAPI 3.1 spec at /openapi.json. They are
// inlined here rather than imported from openapi.json so the function
// bundle is self-contained at deploy time.

import { SCENARIO_WIDGET_META } from './mcp-widget';
import { computeAmtIso } from '../../lib/calc/amtIso';
import { computeNsoResult } from '../../lib/calc/nso';
import { computeRsuResult } from '../../lib/calc/rsu';
import { calculate as computeConcentration } from '../../lib/calc/concentration';
import { calculateProtectivePut } from '../../lib/calc/protectivePut';
import { evaluateQsbs } from '../../lib/calc/qsbs';
import { STATE_CODES } from '../../lib/tax/state-tax';
import { computeEquityFundingComparison } from '../../lib/calc/equityFunding';
import { computeLotDivestPlan } from '../../lib/calc/lotDivest';

import { FILING_STATUSES } from './api';
import {
  parseAmtIsoInput,
  parseNsoInput,
  parseRsuInput,
  parseConcentrationInput,
  parseProtectivePutInput,
  parseQsbsInput,
  parseEquityFundingInput,
  parseRsuLotOptimizeInput,
  MAX_RSU_LOT_ORDER_LOTS,
} from './calc-parsers';

export type McpToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  idempotentHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

// Every agent-callable tool, by MCP name. This is the ONE hand-maintained list
// of tool names in the repo; tests/tool-name-coverage.test.ts pins it against
// TOOLS so the two cannot disagree.
//
// Its job is exhaustiveness. Roughly twenty per-tool lookup tables live across
// poe.ts, sessions.ts, a2a.ts and the codegen scripts, and they were all typed
// `Record<string, ...>` — so adding the eighth tool meant finding each one by
// grep, and a miss produced `undefined` in user-facing bot copy rather than a
// build error. Keyed on ToolName, a missing entry is a compile error at every
// site. Use `Partial<Record<ToolName, T>>` where an entry is genuinely optional.
export type ToolName =
  | 'amt_iso_optimize'
  | 'nso_calculate'
  | 'rsu_sell_vs_hold'
  | 'concentration_analyze'
  | 'protective_put_price'
  | 'qsbs_check'
  | 'equity_funding_plan'
  | 'rsu_lot_optimize';

/** Narrow an untrusted string (a request field, a Poe help topic) to ToolName.
 *  Validates against the canonical tool list rather than whichever lookup table
 *  the caller happens to reach for first. */
export function isToolName(value: string): value is ToolName {
  return TOOL_NAMES.has(value);
}

// The calculator each tool corresponds to: its /tools/<slug> page on the web
// side and its /api/v1/<slug> REST endpoint. Structured routing data,
// declared once and pinned by test to the two places that already encode the
// same adjacency by hand (a2a.ts SKILLS[].rest and the free-tool URLs in
// sessions.ts). Kept out of McpTool itself so it never leaks into the
// published toolspec.json, which is a public artifact.
export const TOOL_SLUG: Record<ToolName, string> = {
  amt_iso_optimize: 'amt-iso',
  nso_calculate: 'nso',
  rsu_sell_vs_hold: 'rsu-sell-vs-hold',
  concentration_analyze: 'concentration',
  protective_put_price: 'protective-put',
  qsbs_check: 'qsbs',
  equity_funding_plan: 'equity-funding',
  rsu_lot_optimize: 'rsu-lot-order',
};

export type McpTool = {
  name: ToolName;
  /**
   * Protocol-level metadata. Carries the ChatGPT Apps SDK widget pointer
   * (see _lib/mcp-widget.ts). Per MCP spec, clients that do not recognise a
   * `_meta` key ignore it, so this is invisible to every other client - and
   * it is deliberately NOT part of buildToolSpec(), keeping the published
   * toolspec.json a clean, host-agnostic artifact.
   */
  _meta?: Record<string, unknown>;
  description: string;
  inputSchema: Record<string, unknown>;
  // JSON Schema for the tool's success result (MCP `outputSchema`). The
  // server returns the same object as `structuredContent` on tools/call.
  outputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  handler: (args: unknown) => unknown;
};

// All tools are pure deterministic calculators with no side effects.
const CALC_HINTS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// Shared inputSchema fragments.
const FILING_SCHEMA = { type: 'string', enum: [...FILING_STATUSES] };
// Enumerate the 50 states + DC the tax engine actually models, so an agent
// that mis-resolves or mistypes a code (e.g. "PR", "UK", or a transposed
// "AC") is rejected at the schema instead of silently receiving a $0
// state-tax result. Sourced from the tax tables so it can never drift.
const STATE_SCHEMA = { type: 'string', enum: STATE_CODES };
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

// Shared optional ticker field — the growth- and volatility-bearing
// calculators (ISO, NSO, RSU, concentration, protective put) accept it as
// an alternative to passing explicit expected-return / sale-price /
// volatility numbers.
const TICKER_SCHEMA = {
  type: 'string',
  description:
    'Optional public-stock symbol (e.g. "NVDA", "AAPL"). When set, the tool substitutes a cached trailing return for any unsupplied expected-return / sale-price field, and a cached implied vol for any unsupplied volatility. Growth and volatility come from two separate cached snapshots, so some symbols resolve only one of the two fields. A symbol not in a given table falls through to a "required field" error for exactly the field it could not resolve: pass that field explicitly, or (for the growth/return/sale-price field) pass the string "market" for the S&P 500 trailing average; never invent a number. The covered-tickers resource (resources/list) lists which symbols resolve which field.',
};

// Appended to every tool description so the model picks it up at
// consideration-time. When one query exercises several OptionsAhoy tools
// (ISO + RSU + concentration, say), summing the per-tool answers is NOT a
// joint optimization, and a model that presents it as one is overstating
// what it has. That warning is the job this note keeps.
//
// It used to end with a beta signup URL. That URL is gone from here, for two
// reasons. It rode into every one of the eight descriptions, so a client
// calling tools/list received eight identical pitches before the user had
// asked anything - and tool descriptions are supposed to describe the tool,
// which is what the Anthropic directory review (2026-07-31) asked for.
// Second, the invite now travels where it belongs: `next_steps.beta` carries
// a per-tool line written for the question actually asked, and since it
// became a first-class result field rather than `_meta` (#206) the model
// actually surfaces it. Two channels for one pitch, and this was the blunt
// one.
const MULTI_TOOL_NOT_JOINT_NOTE =
  ' Results from multiple OptionsAhoy tools in one analysis are independent single-position calculations, not a joint optimization across the positions.';

// Boilerplate appended to every growth-bearing tool's description. Documents
// the conditionally-required growth/volatility pair and the no-defaults
// contract, including the fact that the validator range-checks but cannot
// provenance-check a number: the required-field error catches an OMITTED
// value, never an invented one. Per-field provenance guidance ("must come
// from the user") lives in the individual parameter descriptions and in the
// required-field error messages (calc-parsers.ts), the placement the
// Anthropic directory review asked for.
const STRICT_INPUT_NOTE =
  ' Inputs beyond `required`: this tool also needs the stock\'s expected growth/return AND its volatility, outside `required` only because they can be resolved without an explicit number - supplied directly, resolved by a covered public-stock `ticker`, or (growth/return/sale-price field only) set to the string "market" for the S&P 500 trailing average. Every field in `required` is likewise a fact about the user\'s situation with no built-in default. Neither the growth nor the volatility field has a default or a fallback estimate: their only valid sources are the user\'s own figures, a covered `ticker`, or (growth/return/sale-price only) the "market" sentinel. A call that neither supplies nor resolves one of them returns a required-field error naming the field; a number from any other source is accepted as-is, because a syntactically valid figure passes validation with no provenance check, and it silently changes the result. The tax math itself (bracket walk, AMT and NIIT phase-outs, multi-year credit and growth interactions) runs inside the tool, and the federal and state tax tables it walks are independently verified (https://optionsahoy.com/verification).' +
  MULTI_TOOL_NOT_JOINT_NOTE;

// Boilerplate for tools whose `required` fields must all come from the user
// message. Unlike STRICT_INPUT_NOTE there is no conditionally-required
// growth/volatility pair: qsbs_check has no ticker shortcut at all, while
// protective_put_price and equity_funding_plan DO accept a `ticker`, but it
// resolves conditionally-required or optional fields (per-stack growth /
// implied volatility), so every field listed in `required` still has to be
// supplied by the user. equity_funding_plan's per-stack growth additionally
// accepts the string "market" (S&P 500 trailing average) — see its field
// description. States the no-defaults contract; per-field provenance
// guidance lives in the parameter descriptions.
const STRICT_INPUT_NOTE_NO_TICKER =
  ' Every field listed in `required` is a fact about the user\'s situation with no built-in default: a call missing a required field returns an error naming the field rather than an estimated result, and a number from any other source is accepted as-is, because a syntactically valid figure passes validation with no provenance check. The math runs inside the tool with no randomness and no model inference.' +
  MULTI_TOOL_NOT_JOINT_NOTE;

// qsbs_check only. The `unsure` enums, the partial verdict and the statutory
// tests exist on that tool alone, so this cannot live in the shared note: as a
// blanket claim it promised protective_put_price, equity_funding_plan and
// rsu_lot_optimize an output structure none of them has.
const QSBS_UNSURE_NOTE =
  ' For the enum fields that accept `unsure`, that value is the accurate encoding of a fact the user has not confirmed: it yields a partial verdict flagging that test as unconfirmed, where encoding an unconfirmed fact as yes or no yields a verdict the underlying facts may not support.';

// Vol input shared by amt_iso_optimize, nso_calculate, rsu_sell_vs_hold.
// concentration_analyze defines its own version because it also uses sigma
// for Black-Scholes hedge pricing (dual purpose).
// Appended to every ordinary-income field. The engine walks the brackets on
// the figure it is given and applies NO standard or itemized deduction (the
// STANDARD_DEDUCTION_2026 constant is IRS-conformance-tested and surfaced on
// the verification page, but no calc subtracts it), so the input must already
// be taxable income. Regular tax and the AMTI base legitimately differ here -
// AMT disallows the standard deduction - and one field feeds both, so the
// contract is stated per field rather than guessed from "W-2 income".
// Appended to required fields that are FACTS ABOUT THE USER (share counts,
// prices, balances, income) rather than planning choices (horizon, tenor).
// The validator range-checks these but cannot provenance-check them, so an
// invented figure is accepted silently; the 2026-08-01 input-discipline eval
// caught Opus inventing positionValue=1000000 on a call that routed correctly.
// "values must come from the user" in a parameter description is the placement
// the Anthropic directory review asked for.
const USER_FACT = ' Must come from the user.';

// Required fields that are the user's CHOICE rather than a fact they know:
// horizon, hold period, tenor, protection level, divest fraction. There is no
// true value to contradict a guess here, which makes a silent one worse, not
// better: the user gets an answer to a question they did not ask and never
// learns a different assumption was substituted. All are required, so the tool
// cannot default them either. So the instruction is to ask, not to propose:
// a proposal is only safe if the user is told, and the disclosure would land
// after the call, where nothing can verify it (the 2026-08-01 eval kills at
// the first tool_use for exactly this reason). Opus invented divestFraction
// 0.5 - half the position - for a user who said only "start diversifying".
const PLANNING_CHOICE =
  " The user's choice, not a modelling detail, and it changes the answer: use the value they gave, and if they gave none, ask for it rather than assuming one.";

const TAXABLE_INCOME_NOTE =
  ' This is taxable income after deductions, not gross wages: the engine applies no standard or itemized deduction to it.';

const VOLATILITY_SCHEMA = {
  type: 'number',
  minimum: 0,
  maximum: 5,
  description:
    'Annualized volatility (sigma) of the stock as a decimal (0.72 = 72%). Pass the volatility itself, not a pre-computed drag: the tool derives the horizon-cumulative drag internally, and the correct formula is horizon-dependent. This value must come from the user or from a `ticker` that resolves it from the cached implied-vol table; if neither supplies it, ask the user rather than estimating one.',
};

// ---------------------------------------------------------------------
// Output schemas (the MCP `outputSchema` field on each tool descriptor).
//
// Derived 1:1 from the calc return types in lib/calc/*.ts: every property
// below maps to a field the calc actually returns; do not add fields here
// without adding them to the calc first. Serialization notes that apply
// throughout:
//   - Date values serialize to ISO 8601 date-time strings.
//   - Infinity serializes to null (JSON has no Infinity), so ratio fields
//     that can divide by zero are typed ['number', 'null'].
//   - additionalProperties is left open (JSON Schema default) so the
//     hosted server's optional `next_steps` injection and future additive
//     fields never violate the schema.
// ---------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const num = (description: string): JsonSchema => ({ type: 'number', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
const str = (description: string): JsonSchema => ({ type: 'string', description });
const dateStr = (description: string): JsonSchema => ({
  type: 'string',
  description: `${description} ISO 8601 date-time string.`,
});

// One calendar year of an ISO exercise schedule (amtIso.ts YearTax).
const YEAR_TAX_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Exercise and tax detail for one calendar year of the schedule.',
  properties: {
    year: int('Schedule year, 1-indexed (1 = current year).'),
    shares: num('ISO shares exercised this year.'),
    bargain: num('Bargain element recognized this year in dollars: shares x (projected FMV - strike).'),
    regularFederal: num('Regular federal income tax for the year in dollars (ordinary income only, before AMT).'),
    regularState: num('Regular state income tax for the year in dollars.'),
    tmtFederal: num('Federal tentative minimum tax for the year in dollars.'),
    tmtState: num('State tentative minimum tax for the year in dollars (0 in states without AMT).'),
    amtOwedFederal: num('Federal AMT owed above regular tax this year in dollars.'),
    amtOwedState: num('State AMT owed above regular state tax this year in dollars.'),
    creditRecovered: num('Federal AMT credit applied (recovered) this year in dollars.'),
    cashTax: num('Total cash tax paid this year in dollars: federal + state, net of credit recovery.'),
  },
  required: [
    'year', 'shares', 'bargain', 'regularFederal', 'regularState', 'tmtFederal', 'tmtState',
    'amtOwedFederal', 'amtOwedState', 'creditRecovered', 'cashTax',
  ],
};

// One full exercise schedule evaluated at the horizon (amtIso.ts Schedule).
const AMT_SCHEDULE_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'One exercise schedule evaluated at the planning horizon.',
  properties: {
    label: {
      type: 'string',
      enum: ['lump_sum', 'even_split', 'optimized'],
      description: 'Which candidate plan this schedule represents.',
    },
    years: {
      type: 'array',
      items: YEAR_TAX_SCHEMA,
      description: 'Per-year detail, one entry per year of the effective horizon.',
    },
    totalTax: num('Total cash tax paid across the horizon in dollars.'),
    baselineRegularTax: num('Tax owed with no exercise at all (regular federal + state on ordinary income, summed across the horizon) in dollars.'),
    exerciseTax: num('totalTax minus baselineRegularTax: the marginal tax cost of exercising, in dollars.'),
    creditEarned: num('Federal AMT credit generated across the horizon in dollars.'),
    creditRecovered: num('Federal AMT credit recovered across the horizon in dollars.'),
    creditRemaining: num('Federal AMT credit still unrecovered at the horizon in dollars.'),
    grossGain: num('shares x (projected FMV at horizon - strike): the LTCG-eligible gain in dollars.'),
    federalLTCG: num('Federal long-term capital gains tax (including NIIT) on grossGain in dollars.'),
    stateLTCG: num('State long-term capital gains tax on grossGain in dollars.'),
    amtPremiumFV: num('Future-valued AMT premium stream (exercise tax paid above the no-exercise baseline, compounded at cashReturnRate to the horizon) in dollars.'),
    nfv: num('After-tax Net Final Value at the horizon in dollars: grossGain - federalLTCG - stateLTCG - amtPremiumFV. This is the summary figure each schedule is scored on.'),
  },
  required: [
    'label', 'years', 'totalTax', 'baselineRegularTax', 'exerciseTax', 'creditEarned',
    'creditRecovered', 'creditRemaining', 'grossGain', 'federalLTCG', 'stateLTCG',
    'amtPremiumFV', 'nfv',
  ],
};

const AMT_ISO_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'ISO/AMT exercise optimization result. All dollar amounts are USD.',
  properties: {
    crossoverShares: int('Maximum whole shares exercisable in year 1 before federal AMT exceeds regular tax (the AMT crossover).'),
    crossoverBargain: num('Bargain element in dollars at the crossover share count: crossoverShares x (fmv - strike).'),
    alreadyInAmt: bool('True when the user owes AMT even with zero exercise (regular tax below tentative minimum tax at baseline income).'),
    schedules: {
      type: 'object',
      description: 'The three candidate exercise schedules, each evaluated at the effective horizon. Their nfv values are directly comparable; optimized is the highest-NFV schedule the optimizer found.',
      properties: {
        lumpSum: { ...AMT_SCHEDULE_SCHEMA, description: 'Exercise all shares in year 1.' },
        evenSplit: { ...AMT_SCHEDULE_SCHEMA, description: 'Exercise shares/horizon shares each year.' },
        optimized: { ...AMT_SCHEDULE_SCHEMA, description: 'The NFV-maximal per-year allocation found by the optimizer. The recommended plan.' },
      },
      required: ['lumpSum', 'evenSplit', 'optimized'],
    },
    stateHasAmt: bool('True when the user state levies its own AMT (CA, CO, CT, MN).'),
    bargainPerShare: num('Year-1 bargain element per share in dollars: max(0, fmv - strike).'),
    timing: {
      type: 'object',
      description: 'Timing constraints derived from grantDate and (when departed) terminationDate.',
      properties: {
        grantExpiration: dateStr('Grant expiration date: grantDate + 10 years (IRC 422 maximum ISO term).'),
        qdEligibleDate: dateStr('Earliest qualifying-disposition date measured from grant: grantDate + 2 years.'),
        exerciseWindowClose: {
          type: ['string', 'null'],
          description: 'Post-termination exercise deadline (terminationDate + 90 days) as an ISO 8601 date-time string; null while still employed.',
        },
        maxHorizon: int('Maximum usable planning horizon in years (1..10), capped by grant expiration or the post-termination window.'),
        daysUntilWindowClose: {
          type: ['number', 'null'],
          description: 'Days until the post-termination exercise window closes (can be negative when already past); null while still employed.',
        },
        windowClosed: bool('True when the user departed and the 90-day exercise deadline has already passed.'),
        qdNotYetEligible: bool('True when grantDate + 2 years is still in the future (a sale today could not be a qualifying disposition).'),
      },
      required: [
        'grantExpiration', 'qdEligibleDate', 'exerciseWindowClose', 'maxHorizon',
        'daysUntilWindowClose', 'windowClosed', 'qdNotYetEligible',
      ],
    },
    effectiveHorizon: int('Horizon actually used by the schedules: min(requested horizon, timing.maxHorizon).'),
    departedRecommendation: {
      type: 'object',
      description: 'Present only when hasLeftCompany=true and the 90-day post-termination window is still open: the partial-exercise quantity with the highest expected after-tax value found by a scan over candidate share counts, which can land a few shares off the exact optimum.',
      properties: {
        recommendedShares: int('Share count to exercise within the window, the best found by the scan.'),
        recommendedExerciseTax: num('AMT cost in dollars at the recommended share count.'),
        recommendedNetValue: num('Expected after-tax value in dollars at the hold horizon for the recommended count.'),
        fullExerciseShares: int('Total shares available (the exercise-everything alternative).'),
        fullExerciseTax: num('AMT cost in dollars of exercising all shares.'),
        fullExerciseNetValue: num('Expected after-tax value in dollars at the hold horizon if all shares are exercised.'),
        holdYears: num('Post-exercise hold horizon in years used for the comparison.'),
        futureFmvPerShare: num('Projected FMV per share in dollars at the hold horizon.'),
        recommendedSchedule: { ...AMT_SCHEDULE_SCHEMA, description: 'Year-by-year tax schedule for the recommended share count.' },
        curve: {
          type: 'array',
          description: 'Share-count vs after-tax-value curve sampled uniformly across [0, total shares], for charting.',
          items: {
            type: 'object',
            properties: {
              shares: num('Exercised share count at this sample point.'),
              netValue: num('Expected after-tax value in dollars at this share count.'),
              exerciseTax: num('AMT cost in dollars at this share count.'),
            },
            required: ['shares', 'netValue', 'exerciseTax'],
          },
        },
      },
      required: [
        'recommendedShares', 'recommendedExerciseTax', 'recommendedNetValue', 'fullExerciseShares',
        'fullExerciseTax', 'fullExerciseNetValue', 'holdYears', 'futureFmvPerShare',
        'recommendedSchedule', 'curve',
      ],
    },
  },
  required: [
    'crossoverShares', 'crossoverBargain', 'alreadyInAmt', 'schedules', 'stateHasAmt',
    'bargainPerShare', 'timing', 'effectiveHorizon',
  ],
};

// Shared by nso_calculate and rsu_sell_vs_hold (identical BracketJump type).
const BRACKET_JUMP_SCHEMA: JsonSchema = {
  type: ['object', 'null'],
  description: 'Marginal federal bracket change caused by the new ordinary income; null when the income stays within one bracket.',
  properties: {
    fromRate: num('Marginal federal rate before the event, as a decimal (0.24 = 24%).'),
    toRate: num('Marginal federal rate after the event, as a decimal.'),
    thresholdAtJump: num('Taxable-income threshold in dollars where the bracket changes.'),
  },
  required: ['fromRate', 'toRate', 'thresholdAtJump'],
};

const NSO_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'NSO exercise sell-vs-hold result. All dollar amounts are USD.',
  properties: {
    exercise: {
      type: 'object',
      description: 'Tax bill at exercise on the bargain element (taxed as ordinary W-2 income).',
      properties: {
        bargainElement: num('shares x (currentPrice - strike) in dollars, taxed as ordinary income at exercise.'),
        federal: num('Federal ordinary income tax on the bargain element in dollars.'),
        state: num('State income tax on the bargain element in dollars.'),
        socialSecurity: num('Social Security tax in dollars (0 when not employed or already past the wage base).'),
        medicare: num('Medicare tax in dollars.'),
        additionalMedicare: num('Additional Medicare (0.9%) tax in dollars.'),
        total: num('Total tax at exercise in dollars.'),
        netCashSellAll: num('bargainElement - total: net cash in dollars if every share is sold at exercise.'),
      },
      required: [
        'bargainElement', 'federal', 'state', 'socialSecurity', 'medicare',
        'additionalMedicare', 'total', 'netCashSellAll',
      ],
    },
    bracketJump: BRACKET_JUMP_SCHEMA,
    hold: {
      type: 'object',
      description: 'Exercise now and hold the shares holdYears for long-term capital gains treatment.',
      properties: {
        funding: {
          type: 'string',
          enum: ['sell-to-cover', 'cash'],
          description: 'How strike cost and exercise tax are funded (echo of holdFunding).',
        },
        costBasis: num('Cost basis per share in dollars (the FMV at exercise).'),
        strikeCost: num('Total strike cost in dollars: shares x strike.'),
        cashNeededAtExercise: num('Outside cash required at exercise in dollars (strike + tax under cash funding; 0 under sell-to-cover).'),
        sharesSoldToCover: num('Shares sold at exercise to cover strike + tax (sell-to-cover only; 0 in cash mode).'),
        sharesRetained: num('Shares still held after funding the exercise.'),
        effectiveSalePrice: num('Projected sale price per share in dollars at end of holdYears, after the volatility haircut.'),
        expectedGain: num('Expected capital gain in dollars on the retained shares at sale.'),
        ltcgFederal: num('Federal long-term capital gains tax (including NIIT) on the gain in dollars.'),
        ltcgState: num('State capital gains tax on the gain in dollars.'),
        ltcgTotal: num('Total capital gains tax at sale in dollars.'),
        afterTaxProceedsAtSale: num('After-tax sale proceeds in dollars at end of holdYears.'),
        y0OutflowGain: num('Opportunity-cost gain in dollars the year-0 cash outflow would have earned at the market rate (cash funding only; 0 for sell-to-cover).'),
        y0OutflowLtcgFederal: num('Federal capital gains tax in dollars on the forgone market gain (cash funding only).'),
        y0OutflowLtcgState: num('State capital gains tax in dollars on the forgone market gain (cash funding only).'),
        y0OutflowLtcgTotal: num('Total capital gains tax in dollars on the forgone market gain (cash funding only).'),
        y0OutflowForgoneNet: num('After-tax market growth forgone in dollars by spending cash at exercise: y0OutflowGain - y0OutflowLtcgTotal.'),
        netAtYearN: num('Net after-tax value of the hold strategy in dollars at end of holdYears (after subtracting forgone market growth).'),
      },
      required: [
        'funding', 'costBasis', 'strikeCost', 'cashNeededAtExercise', 'sharesSoldToCover',
        'sharesRetained', 'effectiveSalePrice', 'expectedGain', 'ltcgFederal', 'ltcgState',
        'ltcgTotal', 'afterTaxProceedsAtSale', 'y0OutflowGain', 'y0OutflowLtcgFederal',
        'y0OutflowLtcgState', 'y0OutflowLtcgTotal', 'y0OutflowForgoneNet', 'netAtYearN',
      ],
    },
    sellNowInvest: {
      type: 'object',
      description: 'Counterfactual: sell every share at exercise and reinvest the net cash at expectedMarketReturn for holdYears.',
      properties: {
        netCashAtY0: num('Net cash in dollars after exercise tax, available to reinvest.'),
        marketGain: num('Market growth in dollars on the reinvested cash over holdYears.'),
        ltcgFederal: num('Federal capital gains tax (including NIIT) in dollars on the market gain at the horizon.'),
        ltcgState: num('State capital gains tax in dollars on the market gain.'),
        ltcgTotal: num('Total capital gains tax in dollars on the market gain.'),
        netAtYearN: num('Net after-tax value of sell-now-and-invest in dollars at end of holdYears.'),
      },
      required: ['netCashAtY0', 'marketGain', 'ltcgFederal', 'ltcgState', 'ltcgTotal', 'netAtYearN'],
    },
    holdMinusCashless: num('hold.netAtYearN - sellNowInvest.netAtYearN in dollars. Positive favors holding the shares; negative favors selling at exercise and reinvesting.'),
  },
  required: ['exercise', 'bracketJump', 'hold', 'sellNowInvest', 'holdMinusCashless'],
};

const RSU_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'RSU sell-at-vest vs hold result. All dollar amounts are USD.',
  properties: {
    vest: {
      type: 'object',
      description: 'Tax bill at vest on the full vest value (taxed as ordinary W-2 income).',
      properties: {
        vestValue: num('shares x currentPrice in dollars, taxed as ordinary income at vest.'),
        federal: num('True federal ordinary income tax on the vest value in dollars (marginal bracket, not the withholding).'),
        state: num('State income tax on the vest value in dollars.'),
        socialSecurity: num('Social Security tax in dollars (0 when not employed or already past the wage base).'),
        medicare: num('Medicare tax in dollars.'),
        additionalMedicare: num('Additional Medicare (0.9%) tax in dollars.'),
        total: num('Total tax at vest in dollars.'),
        netCashAtVest: num('vestValue - total: net cash in dollars if every share is sold at vest.'),
        federalWithheldAtVest: num('Mandatory federal supplemental withholding in dollars (22% on the first $1M of supplemental wages, 37% above). When less than vest.federal, the difference is owed at tax time.'),
      },
      required: [
        'vestValue', 'federal', 'state', 'socialSecurity', 'medicare', 'additionalMedicare',
        'total', 'netCashAtVest', 'federalWithheldAtVest',
      ],
    },
    bracketJump: BRACKET_JUMP_SCHEMA,
    hold: {
      type: 'object',
      description: 'Keep the after-tax shares for holdYears, then sell.',
      properties: {
        costBasis: num('Cost basis per share in dollars (FMV at vest).'),
        effectiveSalePrice: num('Projected sale price per share in dollars at end of holdYears, after the volatility haircut.'),
        sharesRetained: num('Shares kept after the sell-to-cover dollar-equivalent of the vest tax.'),
        expectedGain: num('Expected capital gain in dollars on the retained shares: (effectiveSalePrice - costBasis) x sharesRetained.'),
        capGainFederal: num('Federal capital gains tax in dollars on the gain: LTCG (including NIIT) when isLongTerm, else the marginal ordinary rate.'),
        capGainState: num('State capital gains tax in dollars on the gain.'),
        capGainTotal: num('Total capital gains tax in dollars at sale.'),
        isLongTerm: bool('True when holdYears >= 1, so appreciation gets long-term capital gains treatment.'),
        netAtYearN: num('Net after-tax value of holding in dollars at end of holdYears: sale proceeds - capGainTotal.'),
      },
      required: [
        'costBasis', 'effectiveSalePrice', 'sharesRetained', 'expectedGain', 'capGainFederal',
        'capGainState', 'capGainTotal', 'isLongTerm', 'netAtYearN',
      ],
    },
    sellNowInvest: {
      type: 'object',
      description: 'Counterfactual: sell every share at vest and reinvest the net cash at expectedMarketReturn for holdYears.',
      properties: {
        netCashAtY0: num('Net cash in dollars at vest available to reinvest (equals vest.netCashAtVest).'),
        marketGain: num('Market growth in dollars on the reinvested cash over holdYears.'),
        capGainFederal: num('Federal capital gains tax in dollars on the market gain: LTCG (including NIIT) when isLongTerm, else the marginal ordinary rate.'),
        capGainState: num('State capital gains tax in dollars on the market gain.'),
        capGainTotal: num('Total capital gains tax in dollars on the market gain.'),
        isLongTerm: bool('True when holdYears >= 1.'),
        netAtYearN: num('Net after-tax value of sell-at-vest-and-invest in dollars at end of holdYears.'),
      },
      required: [
        'netCashAtY0', 'marketGain', 'capGainFederal', 'capGainState', 'capGainTotal',
        'isLongTerm', 'netAtYearN',
      ],
    },
    holdMinusSell: num('hold.netAtYearN - sellNowInvest.netAtYearN in dollars. Positive favors holding the vested shares; negative favors selling at vest and reinvesting.'),
  },
  required: ['vest', 'bracketJump', 'hold', 'sellNowInvest', 'holdMinusSell'],
};

// concentration_analyze tax slice row (concentration.ts TaxBreakdownRow).
const TAX_ROW_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'One tax slice: a dollar amount taxed at one rate.',
  properties: {
    label: str('Tax line label, e.g. "Federal LTCG", "NIIT", "California".'),
    rate: num('Rate applied to this slice as a decimal (0.15 = 15%).'),
    amount: num('Dollars of gain in this slice.'),
    tax: num('Tax in dollars: amount x rate.'),
  },
  required: ['label', 'rate', 'amount', 'tax'],
};

const CONCENTRATION_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Single-stock concentration analysis. All dollar amounts are USD.',
  properties: {
    concentration: num('Position value / total assets, 0..1.'),
    riskBand: {
      type: 'string',
      enum: ['Low', 'Moderate', 'Concentrated', 'Highly concentrated', 'Extreme'],
      description: 'Qualitative concentration band for the position weight.',
    },
    isLongTermToday: bool('True when the position already qualifies for long-term capital gains treatment.'),
    longTermDate: dateStr('Date the position turns long-term (acquisitionDate + 1 year).'),
    daysUntilLongTerm: num('Days until long-term treatment; 0 when already long-term.'),
    lossExposure: {
      type: 'array',
      description: 'Dollar damage at 30/50/70% single-stock drawdowns.',
      items: {
        type: 'object',
        properties: {
          drop: num('Modeled drawdown as a fraction of position value (0.30, 0.50, 0.70).'),
          dollarLoss: num('Dollars lost at this drawdown.'),
          newConcentration: num('Portfolio concentration (0..1) after the drawdown.'),
        },
        required: ['drop', 'dollarLoss', 'newConcentration'],
      },
    },
    waitForLtInsight: {
      type: ['object', 'null'],
      description: 'Tax saved by waiting for long-term treatment before selling; null when already long-term or no sale is needed.',
      properties: {
        longTermDate: dateStr('Date the position turns long-term.'),
        daysAway: num('Days until that date.'),
        immediateLumpSumTax: num('Tax in dollars on the full sell-down executed today (short-term rates).'),
        delayedLumpSumTax: num('Tax in dollars on the same sale executed after the long-term date.'),
        savings: num('immediateLumpSumTax - delayedLumpSumTax in dollars (floored at 0).'),
      },
      required: ['longTermDate', 'daysAway', 'immediateLumpSumTax', 'delayedLumpSumTax', 'savings'],
    },
    schedule: {
      type: 'array',
      description: 'Sell-down plans over 1, 2, and 3 years; empty when the position is already at or below the target weight.',
      items: {
        type: 'object',
        properties: {
          planKey: { type: 'string', enum: ['lump_sum', 'two_year', 'three_year'], description: 'Plan identifier.' },
          planLabel: str('Human-readable plan name, e.g. "Sell over 2 years".'),
          yearlySales: {
            type: 'array',
            description: 'One entry per sale year: year (1-indexed), saleAmount, gainAmount, isLongTerm, federalTax, stateTax, totalTax in dollars, plus a per-slice breakdown.',
            items: {
              type: 'object',
              properties: {
                year: num('Sale year, 1-indexed.'),
                saleAmount: num('Dollars sold this year.'),
                gainAmount: num('Taxable gain in dollars within the sale.'),
                isLongTerm: bool('True when this sale gets long-term capital gains treatment.'),
                federalTax: num('Federal tax in dollars on this sale (including NIIT).'),
                stateTax: num('State tax in dollars on this sale.'),
                totalTax: num('Total tax in dollars on this sale.'),
                breakdown: { type: 'array', items: TAX_ROW_SCHEMA, description: 'Per-rate tax slices for this sale.' },
              },
              required: ['year', 'saleAmount', 'gainAmount', 'isLongTerm', 'federalTax', 'stateTax', 'totalTax', 'breakdown'],
            },
          },
          totalSale: num('Total nominal sale dollars across the plan years.'),
          totalTax: num('Total tax in dollars across the plan years.'),
          endOfHorizonWealth: num('Total after-tax wealth in dollars at the end of the 3-year comparison horizon.'),
          savingsVsLumpSum: num('Raw tax saved in dollars vs selling everything today; positive means this plan pays less tax.'),
          wealthVsLumpSum: num('End-of-horizon wealth delta in dollars vs the sell-everything-today baseline; positive means this plan ends wealthier.'),
          year1IsShortTerm: bool('True when the first sale year would be taxed at short-term rates.'),
          taxBreakdown: { type: 'array', items: TAX_ROW_SCHEMA, description: 'Plan-total tax slices, same-rate rows merged.' },
          wealthByYear: {
            type: 'array',
            items: { type: 'number' },
            description: 'Total wealth in dollars at the end of each year, t = 0..3 (4 points). For charting.',
          },
        },
        required: [
          'planKey', 'planLabel', 'yearlySales', 'totalSale', 'totalTax', 'endOfHorizonWealth',
          'savingsVsLumpSum', 'wealthVsLumpSum', 'year1IsShortTerm', 'taxBreakdown', 'wealthByYear',
        ],
      },
    },
    hedging: {
      type: 'object',
      description: 'Modeled cost of a protective hedge covering the full position. Defaults to a 1-year 30%-OTM put; if a `hedgeChoice` is supplied, this block prices that structure (kind / protectionLevel / tenorYears, plus a short call for a collar).',
      properties: {
        kind: { type: 'string', enum: ['put', 'collar'], description: 'Structure priced: "put" (default) or "collar" when a hedgeChoice with kind:"collar" and upsideCapPct was supplied.' },
        protectionLevel: num('Floor as a fraction below spot (0.30 = a 30%-OTM put). Echoes hedgeChoice.protectionLevel, else 0.30.'),
        tenorYears: num('Hedge tenor in years. Echoes hedgeChoice.tenorYears, else 1.'),
        strike: num('Long put strike in dollars ((1 - protectionLevel) x position value).'),
        putPrice: num('Gross long-put premium in dollars for the tenor.'),
        callStrike: num('Collar short-call strike in dollars ((1 + upsideCapPct) x position value). Omitted for a put.'),
        callPrice: num('Collar short-call premium in dollars received. Omitted for a put.'),
        netPremium: num('Net premium paid in dollars: putPrice for a put, max(0, putPrice - callPrice) for a collar.'),
        sigma: num('Annualized volatility used in pricing (explicit or ticker-implied vol, else a sector-typical implied volatility).'),
        riskFreeRate: num('Annualized risk-free rate used in pricing, as a decimal.'),
      },
      required: ['kind', 'protectionLevel', 'tenorYears', 'strike', 'putPrice', 'netPremium', 'sigma', 'riskFreeRate'],
    },
    sectorContextLine: str('One-line volatility/drawdown context for the chosen sector.'),
    advisorBenchmarkLine: str('One-line comparison of the user weight vs the common advisor 10% single-name guideline.'),
  },
  required: [
    'concentration', 'riskBand', 'isLongTermToday', 'longTermDate', 'daysUntilLongTerm',
    'lossExposure', 'waitForLtInsight', 'schedule', 'hedging', 'sectorContextLine',
    'advisorBenchmarkLine',
  ],
};

const PROTECTIVE_PUT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Protective put, zero-cost collar, and put-spread pricing on a single-stock position. All dollar amounts are USD.',
  properties: {
    inputs: {
      type: 'object',
      description: 'Echo of the resolved inputs actually priced: positionValue, sector, volatility (the sigma used after ticker/sector resolution), protectionLevel, tenorYears, plus expectedReturn, spreadRiskLevel, and tickerLabel when supplied.',
      properties: {
        positionValue: num('Position value priced, in dollars.'),
        sector: str('Sector tag used for defaults.'),
        volatility: num('Annualized sigma actually used in pricing, as a decimal.'),
        protectionLevel: num('Protection level as a fraction below spot (0.10 = 10% OTM put).'),
        tenorYears: num('Option tenor in years.'),
        expectedReturn: num('Caller-supplied annual expected return used for probability metrics. Omitted when not supplied.'),
        spreadRiskLevel: num('Put spread floor breach risk echoed from the request (snapped to a supported preset). Omitted when not supplied.'),
        tickerLabel: str('Display label echoed from the request (ticker or tickerLabel). Omitted when not supplied.'),
      },
      required: ['positionValue', 'sector', 'volatility', 'protectionLevel', 'tenorYears'],
    },
    riskFreeRate: num('Annualized risk-free rate used in option pricing, looked up for the tenor, as a decimal.'),
    realWorldDrift: num('Annual real-world drift used for the probability metrics: expectedReturn when supplied, else the sector long-run return. Does not affect premium math.'),
    barePut: {
      type: 'object',
      description: 'Bare protective put: pay premium for a hard floor.',
      properties: {
        strike: num('Put strike in dollars: (1 - protectionLevel) x position value.'),
        premium: num('Put premium in dollars for the full tenor.'),
        annualCost: num('Premium annualized, in dollars per year.'),
        annualCostPct: num('Annualized premium as a fraction of position value.'),
        maxLoss: num('Worst-case loss in dollars with the put in place: position - strike + premium.'),
        badYearPrice: num('Position value in dollars at the 10th-percentile (1-in-10 bad year) outcome under real-world drift.'),
        badYearDropPct: num('Bad-year drawdown as a fraction of position value (always >= 0).'),
        coveredLossAtBadYear: num('Dollars the put pays at the bad-year price; 0 when the bad-year drop never reaches the protection floor.'),
        premiumToCoveredRatio: {
          type: ['number', 'null'],
          description: 'Premium per dollar of bad-year coverage. null (serialized from Infinity) when the put covers nothing at the bad-year price; above ~0.40 the floor is set too deep.',
        },
        expectedProfit: num('Expected position profit in dollars over the tenor under real-world drift.'),
        premiumToExpectedProfitRatio: {
          type: ['number', 'null'],
          description: 'Fraction of typical-period expected profit consumed by the premium. null (serialized from Infinity) when expected profit is zero or negative; above ~0.50 the hedge eats most of the upside.',
        },
      },
      required: [
        'strike', 'premium', 'annualCost', 'annualCostPct', 'maxLoss', 'badYearPrice',
        'badYearDropPct', 'coveredLossAtBadYear', 'premiumToCoveredRatio', 'expectedProfit',
        'premiumToExpectedProfitRatio',
      ],
    },
    collar: {
      type: 'object',
      description: 'Put financed by a short call: lower or zero net premium in exchange for capped upside.',
      properties: {
        putStrike: num('Long put strike in dollars (same floor as the bare put).'),
        callStrike: num('Short call strike in dollars (the upside cap level).'),
        netPremium: num('Net premium in dollars: put premium - call premium, floored at 0.'),
        annualCost: num('Net premium annualized, in dollars per year.'),
        annualCostPct: num('Annualized net premium as a fraction of position value.'),
        maxLoss: num('Worst-case loss in dollars with the collar in place.'),
        upsideCap: num('Maximum upside in dollars before the short call caps gains: callStrike - position value.'),
        upsideCapPct: num('Maximum upside as a fraction of position value.'),
        isZeroCost: bool('True when the solved call strike makes the collar effectively zero net premium.'),
        capProbability: num('Real-world probability (0..1) the stock finishes above the call strike at expiration, i.e. the upside cap binds.'),
      },
      required: [
        'putStrike', 'callStrike', 'netPremium', 'annualCost', 'annualCostPct', 'maxLoss',
        'upsideCap', 'upsideCapPct', 'isZeroCost', 'capProbability',
      ],
    },
    putSpread: {
      type: 'object',
      description: 'Put debit spread: long put at the protection floor financed by a short put at a lower strike. Cheaper than the bare put and needs no short call (so it works on unexercised employee options a collar cannot cover), but protection stops at the short strike and losses resume below it. The short strike is solved so the real-world probability the stock ENDS below it equals spreadRiskLevel.',
      properties: {
        available: bool('False when no useful spread exists at these inputs: the 1-in-N short strike lands at/above the floor (floor already deep for this risk level) or the short leg does not reduce cost. When false, the numeric fields of this block are null and unavailableReason carries the explanation in their place.'),
        unavailableReason: {
          type: ['string', 'null'],
          enum: ['floor', 'no-rebate', null],
          description: "Why the spread is unavailable; null when available. 'floor' = the solved short strike sits at/above the protection floor (or within 1% of position of it). 'no-rebate' = the short leg does not strictly reduce cost.",
        },
        longStrike: num('Long put strike in dollars (same floor as the bare put).'),
        longPremium: num('Long put premium in dollars for the full tenor (same as barePut.premium).'),
        shortStrike: num('Short put strike in dollars, solved so P(end below it) = spreadRiskLevel.'),
        shortPremium: num('Short put premium in dollars received for the full tenor.'),
        shortSigma: num('Annualized sigma used to price the short leg, as a decimal (equals volatility in flat-sigma mode).'),
        netPremium: num('Net debit in dollars: long premium - short premium, floored at 0.'),
        annualCost: num('Net premium annualized, in dollars per year.'),
        annualCostPct: num('Annualized net premium as a fraction of position value.'),
        maxLossInBand: num('Loss in dollars if the stock ends anywhere inside the protected band (floor holds): position - longStrike + netPremium. Below the short strike, losses resume dollar-for-dollar on top of this.'),
        bandWidth: num('Width of the protected band in dollars: longStrike - shortStrike (the spread max payout).'),
        shortStrikeDropPct: num('Short strike as a drawdown from spot, as a fraction of position value.'),
        breachProbability: num('Achieved real-world probability (0..1) the stock ends below the short strike; approximately spreadRiskLevel after the solve.'),
        riskLevel: num('The spreadRiskLevel preset the solve targeted (0.20 / 0.10 / 0.05 / 0.01), after snapping.'),
        savingsPct: num('Fraction of the bare put premium rebated by the short leg: shortPremium / longPremium.'),
        coveredLossAtBadYear: num('Dollars the spread pays at the bad-year price, capped at bandWidth; 0 when the bad-year drop never reaches the floor.'),
      },
      required: [
        'available', 'unavailableReason', 'longStrike', 'longPremium', 'shortStrike',
        'shortPremium', 'shortSigma', 'netPremium', 'annualCost', 'annualCostPct',
        'maxLossInBand', 'bandWidth', 'shortStrikeDropPct', 'breachProbability',
        'riskLevel', 'savingsPct', 'coveredLossAtBadYear',
      ],
    },
    payoffTable: {
      type: 'array',
      description: 'Terminal P&L in dollars at each 10%-step drawdown across payoffRange, for the bare put, the collar, the put spread, and the unhedged position.',
      items: {
        type: 'object',
        properties: {
          drawdownPct: num('Price move as a fraction of spot (-0.30 = down 30%, 0.2 = up 20%).'),
          barePutPnl: num('Position + put P&L in dollars at this move.'),
          collarPnl: num('Position + collar P&L in dollars at this move.'),
          spreadPnl: {
            type: ['number', 'null'],
            description: 'Position + put-spread P&L in dollars at this move. null (serialized from NaN) when putSpread.available is false.',
          },
          unhedgedPnl: num('Unhedged position P&L in dollars at this move.'),
        },
        required: ['drawdownPct', 'barePutPnl', 'collarPnl', 'spreadPnl', 'unhedgedPnl'],
      },
    },
    payoffRange: {
      type: 'object',
      description: 'Price-move range covered by payoffTable, extended at least 15% beyond each collar arm and at least +/-50%.',
      properties: {
        lowerPct: num('Lower bound of the modeled price move, as a fraction of spot (negative).'),
        upperPct: num('Upper bound of the modeled price move, as a fraction of spot.'),
      },
      required: ['lowerPct', 'upperPct'],
    },
    recommended: {
      type: 'string',
      enum: ['collar', 'protective-put', 'put-spread', 'none'],
      description: 'Suggested structure, in triage order: collar unless its cap binds too often (>20% probability); then protective-put unless the put is expensive; then put-spread when one is available and cleanly priced (cheaper by construction); none when nothing is clean. The recommended structure is the one whose card carries no warning.',
    },
  },
  required: [
    'inputs', 'riskFreeRate', 'realWorldDrift', 'barePut', 'collar', 'putSpread',
    'payoffTable', 'payoffRange', 'recommended',
  ],
};

const QSBS_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Section 1202 QSBS qualification result. All dollar amounts are USD.',
  properties: {
    verdict: {
      type: 'string',
      enum: ['qualifies', 'partial', 'too-soon', 'caveats', 'disqualified'],
      description: 'Overall verdict. "partial" = qualifies but at a sub-100% exclusion tier (e.g. an OBBBA 3- or 4-year hold gives 50% or 75%). "caveats" = qualifies, but one or more tests returned "unsure" (pass conditional on facts the caller marked unknown). "too-soon" = the holding period has not reached any exclusion tier yet.',
    },
    exclusionPercent: {
      type: 'number',
      enum: [0, 0.5, 0.75, 1],
      description: 'Fraction of the capped gain excludable from federal tax, per the era and holding-period tier.',
    },
    perIssuerCap: num('Statutory per-issuer cap in dollars: $10M pre-OBBBA, $15M for stock acquired after July 4, 2025.'),
    tenXBasisCap: num('10 x adjustedBasis cap in dollars.'),
    applicableCap: num('max(perIssuerCap, tenXBasisCap): the exclusion cap actually applied, in dollars.'),
    excludableGain: num('Portion of expectedGain excludable from federal tax in dollars.'),
    taxableGain: num('Portion of expectedGain still federally taxable in dollars (overage above the cap plus any non-excluded fraction).'),
    federalTaxSaved: num('Federal LTCG tax (including NIIT) avoided on the excluded gain, in dollars.'),
    stateConforms: {
      type: 'string',
      enum: ['full', 'partial', 'none'],
      description: 'Whether the user state conforms to the federal 1202 exclusion.',
    },
    stateNote: str('Per-state conformity explanation. May be omitted.'),
    cappedOverageNote: str('Present only when expectedGain exceeds applicableCap and an exclusion is in play: explains that the overage is fully taxable regardless of holding period and that spreading shares across separate taxpayers (e.g. non-grantor trusts) can multiply the per-issuer exclusion. Omitted otherwise.'),
    holdingYears: num('Calendar-aware years between acquisitionDate and saleDate.'),
    yearsUntilFullExclusion: num('Additional years to hold before reaching the 100% exclusion tier; 0 when already reached.'),
    era: {
      type: 'string',
      enum: ['pre-2009', 'pre-2010', 'pre-obbba', 'obbba'],
      description: 'Acquisition-era classification that sets the exclusion schedule (50% pre-2009 era, 75% pre-2010 era, 100% at 5y pre-OBBBA, tiered 50/75/100% at 3/4/5y under OBBBA).',
    },
    tests: {
      type: 'array',
      description: 'The six statutory tests with per-test status, identifying any gate that failed.',
      items: {
        type: 'object',
        properties: {
          id: str('Stable test identifier.'),
          label: str('Human-readable test name.'),
          status: {
            type: 'string',
            enum: ['pass', 'fail', 'unsure', 'wait'],
            description: '"wait" means the test will pass with more holding time.',
          },
          detail: str('One-line explanation of the test outcome.'),
        },
        required: ['id', 'label', 'status', 'detail'],
      },
    },
  },
  required: [
    'verdict', 'exclusionPercent', 'perIssuerCap', 'tenXBasisCap', 'applicableCap',
    'excludableGain', 'taxableGain', 'federalTaxSaved', 'stateConforms', 'holdingYears',
    'yearsUntilFullExclusion', 'era', 'tests',
  ],
};

// One plan on the equity-funding risk/wealth frontier (equityFunding.ts NamedPlan).
const NAMED_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'One sale plan on the risk/wealth frontier.',
  properties: {
    planKey: {
      type: 'string',
      enum: ['recommended', 'lock_in_now', 'balanced', 'hold_for_growth', 'candidate'],
      description: 'Plan identifier. "candidate" entries appear only inside frontier.',
    },
    planLabel: str('Human-readable plan name.'),
    plan: {
      type: 'object',
      description: 'The full sale schedule for this plan. Nested year/sale entries follow the shapes described here and may carry additional fields.',
      properties: {
        feasible: bool('True when the schedule reaches the after-tax target by the target date.'),
        targetAfterTax: num('Echo of the requested net cash target in dollars.'),
        targetDateISO: str('Echo of the target date as an ISO date string.'),
        totalAfterTaxAchieved: num('Net after-tax cash in dollars the schedule produces by the target date (including after-tax cash interest when cashInterestRate is set).'),
        totalSharesSold: num('Total shares sold across the schedule.'),
        totalGrossProceeds: num('Total gross sale proceeds in dollars.'),
        totalTaxes: {
          type: 'object',
          description: 'Tax totals across all scheduled sales, in dollars.',
          properties: {
            federal: num('Federal capital gains / ordinary tax in dollars.'),
            state: num('State tax in dollars.'),
            niit: num('Net Investment Income Tax (3.8%) in dollars.'),
            total: num('Total tax in dollars.'),
          },
          required: ['federal', 'state', 'niit', 'total'],
        },
        schedule: {
          type: 'array',
          description: 'Per-year sale schedule. Each entry: year, saleDateISO, sales (array of per-lot entries: stackIndex, ticker, lotIndex, shares, grossProceeds, gainAmount, isLongTerm, federalTax, stateTax, niit, netCash), yearGrossProceeds, yearTotalTax, yearNetCash, runningCumulativeNet.',
          items: { type: 'object', additionalProperties: true },
        },
        comparison: {
          type: 'object',
          description: 'This schedule vs the naive sell-everything-in-the-target-year alternative.',
          properties: {
            sellAllInTargetYearTotalTax: num('Tax in dollars if all needed shares were sold in the target year.'),
            sellAllInTargetYearAfterTax: num('After-tax cash in dollars under that naive plan.'),
            optimizedSavingsVsTargetYearSale: num('Tax saved in dollars by this schedule vs the naive plan.'),
            optimizedSavingsPct: num('Tax saved as a fraction of the naive plan tax.'),
          },
          required: [
            'sellAllInTargetYearTotalTax', 'sellAllInTargetYearAfterTax',
            'optimizedSavingsVsTargetYearSale', 'optimizedSavingsPct',
          ],
        },
        remainingShares: num('Shares retained after all scheduled sales.'),
        remainingPositionValue: num('Market value in dollars of retained shares at the projected target-date price.'),
        remainingPositionAfterTax: num('After-tax value in dollars of liquidating all retained shares at the target date (the cash backstop if scheduled sales come in light).'),
        remainingNetByStack: {
          type: 'array',
          items: { type: 'number' },
          description: 'Per-stack after-tax retained value in dollars, parallel to the input stacks array.',
        },
        shortfall: {
          type: 'object',
          description: 'Present only when the target is not reachable from the available inventory.',
          properties: {
            maxAchievableAfterTax: num('Maximum after-tax cash in dollars achievable by the target date.'),
            gap: num('Dollars short of the target.'),
          },
          required: ['maxAchievableAfterTax', 'gap'],
        },
      },
      required: [
        'feasible', 'targetAfterTax', 'targetDateISO', 'totalAfterTaxAchieved', 'totalSharesSold',
        'totalGrossProceeds', 'totalTaxes', 'schedule', 'comparison', 'remainingShares',
        'remainingPositionValue', 'remainingPositionAfterTax', 'remainingNetByStack',
      ],
    },
    wealthAtTarget: num('Total wealth in dollars at the target date: net cash plus retained shares at the projected price. The metric the recommendation maximizes.'),
    totalTax: num('Total tax paid across the plan in dollars.'),
    shortfallProbability: num('Lognormal probability (0..1) that realized cash lands below the target. 0 means a deterministic hit (sell everything today).'),
    lockInFraction: num('Fraction (0..1) of the target locked in by an immediate sale, for hybrid candidates. Omitted on pure named plans.'),
  },
  required: ['planKey', 'planLabel', 'plan', 'wealthAtTarget', 'totalTax', 'shortfallProbability'],
};

const EQUITY_FUNDING_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Equity-funding plan comparison: four named plans plus the full risk/wealth frontier. All dollar amounts are USD.',
  properties: {
    recommended: {
      ...NAMED_PLAN_SCHEMA,
      description: 'The wealth-maximal plan whose shortfall probability is at or below the applied risk tolerance. This is the plan the risk tolerance selects out of the frontier.',
    },
    lockInNow: {
      ...NAMED_PLAN_SCHEMA,
      description: 'Sell everything needed in the current calendar year: minimum price risk, usually highest tax.',
    },
    balanced: {
      ...NAMED_PLAN_SCHEMA,
      description: 'Bracket-aware spread across all candidate years: minimum tax.',
    },
    holdForGrowth: {
      ...NAMED_PLAN_SCHEMA,
      description: 'Sell only in the target year: maximum expected wealth, maximum price risk.',
    },
    frontier: {
      type: 'array',
      items: NAMED_PLAN_SCHEMA,
      description: 'All candidate plans from the hybrid lock-in sweep plus the named plans, sorted by shortfall probability.',
    },
    targetAfterTax: num('Echo of the requested net cash target in dollars.'),
    targetDateISO: str('Echo of the target date as an ISO date string.'),
    appliedRiskTolerance: num('Shortfall-probability tolerance actually applied (default 0.10 when not supplied).'),
  },
  required: [
    'recommended', 'lockInNow', 'balanced', 'holdForGrowth', 'frontier',
    'targetAfterTax', 'targetDateISO', 'appliedRiskTolerance',
  ],
};

// One (lot, sale-date) row in the RSU-lot-order schedule (lotDivest.ts LotDivestSale).
// Date fields serialize to ISO strings via JSON.stringify at the transport layer.
const LOT_DIVEST_SALE_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'One vested lot sold, in whole or part, on one date.',
  properties: {
    lotIndex: num('0-based index into the input lots array this row draws from.'),
    vestDate: str('Vest (acquisition) date of the lot, ISO date-time string.'),
    saleDate: str('Date this block is sold, ISO date-time string: today, a long-term-crossing date, or Jan 2 of a later plan year.'),
    year: num('Calendar tax year of the sale.'),
    shares: num('Shares sold in this row (may be fractional).'),
    grossProceeds: num('Gross sale proceeds in dollars (shares x current price; flat-price assumption).'),
    gainAmount: num('Realized capital gain, negative for a loss, in dollars.'),
    isLongTerm: bool('True when the lot was held more than one year at the sale date (long-term capital gain).'),
    taxAttributed: num('Signed tax attributed to this row in dollars; a loss row is negative (the tax it removes).'),
  },
  required: ['lotIndex', 'vestDate', 'saleDate', 'year', 'shares', 'grossProceeds', 'gainAmount', 'isLongTerm', 'taxAttributed'],
};

const LOT_DIVEST_YEAR_GROUP_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'All sales in one tax year, after Schedule D netting.',
  properties: {
    year: num('Calendar tax year.'),
    sales: { type: 'array', items: LOT_DIVEST_SALE_SCHEMA, description: 'Per-lot sale rows in this year.' },
    netLong: num('Net long-term gain or loss after netting, in dollars.'),
    netShort: num('Net short-term gain or loss after netting, in dollars.'),
    tax: num('Total tax for this year (federal + state + NIIT), in dollars.'),
    effectiveRate: num('Year tax divided by year net gain, 0..1.'),
    carryforwardGenerated: num('Capital loss carried into the next plan year from this year, in dollars (0 when the year nets positive).'),
  },
  required: ['year', 'sales', 'netLong', 'netShort', 'tax', 'effectiveRate', 'carryforwardGenerated'],
};

const HORIZON_CARD_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Total tax and after-tax proceeds for the same divest target under a given horizon.',
  properties: {
    horizonYears: num('Plan length in tax years (1 = sell all now, 2, or 3).'),
    totalTax: num('Total plan tax under this horizon, in dollars.'),
    afterTaxKept: num('After-tax proceeds from the divested shares under this horizon, in dollars.'),
  },
  required: ['horizonYears', 'totalTax', 'afterTaxKept'],
};

const DEFERRAL_CALLOUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'A short-term lot that becomes long-term if its sale waits past longTermDate.',
  properties: {
    lotIndex: num('0-based index into the input lots array.'),
    longTermDate: str('Date the lot becomes long-term, ISO date-time string (a sale strictly after the first vest anniversary).'),
    daysToWait: num('Days from the planned sale date to longTermDate.'),
    taxSaved: num('Tax saved by waiting for long-term treatment, in dollars.'),
    amountAtRisk: num('Position value kept exposed to the stock while waiting, in dollars.'),
  },
  required: ['lotIndex', 'longTermDate', 'daysToWait', 'taxSaved', 'amountAtRisk'],
};

const RSU_LOT_OPTIMIZE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'RSU lot-order divest plan: which lots to sell on which dates to divest the target share count at the lowest total tax, versus a first-in-first-out (FIFO) sell order. All dollar amounts are USD.',
  properties: {
    sharesToSell: num('Shares the plan divests (round(divestFraction x totalShares), floored at 1).'),
    totalShares: num('Total shares across all input lots.'),
    totalGross: num('Gross proceeds from the divested shares, in dollars.'),
    totalTax: num('Total plan tax across all years (federal LTCG + NIIT + state, net of in-plan loss carryforward), in dollars.'),
    totalAfterTax: num('After-tax proceeds from the divested shares, in dollars.'),
    schedule: { type: 'array', items: LOT_DIVEST_YEAR_GROUP_SCHEMA, description: 'The sell plan, grouped by tax year.' },
    keptUnrealizedGain: num('Unrealized gain still carried by the shares NOT sold, in dollars (deferred, not eliminated).'),
    carryforwardRemaining: num('Capital loss remaining at the end of the plan horizon, in dollars (reported, not modeled into future years).'),
    headlineAfterTaxKept: num('After-tax proceeds under the plan, in dollars: the headline "you keep $X" figure.'),
    headlineDeltaVsFifo: num('Dollars saved versus selling oldest-first (FIFO) on the SAME schedule. Pure lot-selection benefit; >= 0 by construction.'),
    attribution: {
      type: 'object',
      description: 'Telescoping attribution of the total saving vs a FIFO-all-today sale. lotSelection + spreadingDeferral = total.',
      properties: {
        lotSelection: num('Saving from choosing which lots to sell (equals headlineDeltaVsFifo), in dollars.'),
        spreadingDeferral: num('Saving from spreading sales across years and deferring for long-term status, in dollars. Can be <= 0 in loss-mix cases.'),
        total: num('Total saving vs selling oldest-first, all today, in dollars.'),
      },
      required: ['lotSelection', 'spreadingDeferral', 'total'],
    },
    horizonCards: { type: 'array', items: HORIZON_CARD_SCHEMA, description: 'The same divest target under a 1-year ("all now"), 2-year, and 3-year plan, for the trade-off strip.' },
    deferralCallouts: { type: 'array', items: DEFERRAL_CALLOUT_SCHEMA, description: 'Per-lot short-term-to-long-term deferral opportunities.' },
  },
  required: [
    'sharesToSell', 'totalShares', 'totalGross', 'totalTax', 'totalAfterTax', 'schedule',
    'keptUnrealizedGain', 'carryforwardRemaining', 'headlineAfterTaxKept', 'headlineDeltaVsFifo',
    'attribution', 'horizonCards', 'deferralCallouts',
  ],
};

export const TOOLS: McpTool[] = [
  {
    name: 'amt_iso_optimize',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'ISO/AMT Exercise Optimization', ...CALC_HINTS },
    description:
      'Use this when someone asks how or when to exercise incentive stock options (ISOs), whether exercising will trigger an AMT bomb or phantom income, whether to exercise early, how to avoid or minimize the alternative minimum tax (AMT) on an exercise, or for the best multi-year ISO exercise schedule. Multi-year Incentive Stock Option (ISO) exercise schedule that maximizes after-tax Net Final Value (NFV) at the planning horizon. NFV is the after-all-tax cash equivalent of the position at year `horizon`, summing exercised shares (held to LTCG) plus the time-valued tax stream paid along the way; the optimizer chooses the per-year share allocation that lands the highest NFV. The headline result is `schedules.optimized.nfv`, the dollar NFV of the recommended plan; `schedules.lumpSum` and `schedules.evenSplit` are baseline plans whose `nfv` deltas show the value added by the optimized schedule. Use this tool for ISO planning; for NSO grants use `nso_calculate`, for RSUs at vest use `rsu_sell_vs_hold`, for §1202 QSBS qualification use `qsbs_check`. Models AMT credit recovery across future years, grant-expiration timing, and the post-termination exercise window. Pure deterministic computation: no network access, no PII retention; federal + 50-state tax tables and AMT brackets are compiled in. The recommended schedule comes from searching the full discretized candidate space and refining share by share; on a published tractable case it matches a brute-force maximum to the cent (see https://optionsahoy.com/verification). `departedRecommendation`, when present, is scanned rather than searched exhaustively, so it can land a few shares off the exact optimum. Returns `schedules` (`lumpSum`, `evenSplit`, `optimized`), `crossoverShares`, `crossoverBargain`, `alreadyInAmt`, `timing`, `stateHasAmt`, `bargainPerShare`, `effectiveHorizon`, and `departedRecommendation`; see `outputSchema` for the full shape. Example call: {shares: 10000, strike: 2, fmv: 200, expectedGrowth: 0.15, volatility: 0.5, filingStatus: "married_joint", ordinaryIncome: 400000, stateCode: "CA", carryforwardCredit: 0, horizon: 4, cashReturnRate: 0.05, grantDate: "2022-01-15", hasLeftCompany: false, terminationDate: null}.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'strike', 'fmv', 'filingStatus',
        'ordinaryIncome', 'stateCode', 'horizon',
        'grantDate', 'hasLeftCompany',
      ],
      properties: {
        shares: {
          type: 'integer',
          minimum: 1,
          description:
            'Total Incentive Stock Option (ISO) shares available to exercise across the planning horizon.' + USER_FACT,
        },
        strike: {
          type: 'number',
          minimum: 0,
          description: 'Strike price per share, USD.' + USER_FACT,
        },
        fmv: {
          type: 'number',
          minimum: 0,
          description:
            'Current fair market value per share, USD. Anchors year-1 of the growth path; future years compound from here using expectedGrowth and volatilityDrag.' + USER_FACT,
        },
        expectedGrowth: {
          type: ['number', 'string'],
          description:
            'Annual expected stock growth as a decimal (0.10 = 10%), or the string "market" to use the S&P 500 trailing average when the user has no view. Required unless `ticker` resolves it from trailing CAGR. This tool has no default for it: a value not stated by the user, not resolved by a covered `ticker`, and not the "market" sentinel is outside the input contract.',
        },
        ticker: TICKER_SCHEMA,
        volatility: VOLATILITY_SCHEMA,
        volatilityDrag: {
          type: 'number',
          minimum: 0,
          maximum: 0.99,
          description:
            'Alternative to `volatility`: the multiplicative price haircut already computed for the planning horizon. Supply this OR `volatility` (if both are given, volatilityDrag wins). This field is for a drag figure that already exists from a prior computation; the drag formula is horizon-dependent, so a figure derived for a different horizon does not carry over. Supplying `volatility` instead lets the tool derive it.',
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description:
            'Federal filing status. Drives the ordinary-bracket walk, the AMT exemption tier ($90,100 single / $140,200 MFJ for 2026), and the AMT exemption phaseout start ($500,000 single / $1,000,000 MFJ).',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description:
            'Annual ordinary income before this exercise, USD. Baseline for the bracket walk and the AMT exemption phaseout.' + USER_FACT + TAXABLE_INCOME_NOTE,
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
            'Existing federal AMT credit (Minimum Tax Credit, Form 8801) carryforward from prior tax years, USD. Recoverable in future years where regular federal tax exceeds tentative minimum tax. Optional; defaults to 0, which is correct for most first-time exercisers. Only a prior-year AMT credit makes it non-zero.',
        },
        horizon: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description:
            'Planning horizon in years (1..10). The optimizer searches all feasible per-year share allocations across this many years.' + PLANNING_CHOICE,
        },
        cashReturnRate: {
          type: 'number',
          description:
            'Annual after-tax return on idle cash (decimal), used to time-value the cash-tax stream. 0.05 = 5% (~short-Treasury yield). Optional: defaults to 0.04 (4%, a short-Treasury-like after-tax yield) when omitted, and an explicit value overrides that default. At 0 the math collapses to a nominal sum.',
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
            'Separation date (YYYY-MM-DD). Required only when hasLeftCompany=true (it drives the 90-day exercise-window deadline); omit it or pass null when still employed. No longer in `required` so the common employed case needs no placeholder.',
        },
      },
    },
    outputSchema: AMT_ISO_OUTPUT_SCHEMA,
    handler: (args) => computeAmtIso(parseAmtIsoInput(args)),
  },
  {
    name: 'nso_calculate',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'NSO Sell-vs-Hold Analysis', ...CALC_HINTS },
    description:
      'Use this when someone asks whether to exercise and hold or exercise and sell non-qualified stock options (NSOs), about a cashless exercise or same-day sale of NSOs, or what tax an NSO exercise triggers. After-tax payout on a non-qualified stock option (NSO) exercise: federal, state, and FICA (Social Security + Medicare + Additional Medicare), comparing sell-at-exercise vs hold-for-long-term-capital-gains over the chosen horizon. Use for NSOs; for ISOs use `amt_iso_optimize`, for RSUs use `rsu_sell_vs_hold`. Deterministic, offline; tax tables compiled in. Optional `ticker` resolves `expectedSalePrice` from a bundled trailing-CAGR snapshot.\n\nReturns a top-level object with these keys:\n- `exercise`: bargainElement, federal, state, socialSecurity, medicare, additionalMedicare, total, netCashSellAll.\n- `hold`: costBasis, strikeCost, sharesSoldToCover, sharesRetained, effectiveSalePrice, expectedGain, ltcgFederal, ltcgState, ltcgTotal, afterTaxProceedsAtSale, netAtYearN. NSO hold is always long-term (sub-1-year is out of scope), so there is no separate long-term flag.\n- `sellNowInvest`: counterfactual where shares are sold at exercise and proceeds reinvested at expectedMarketReturn.\n- `holdMinusCashless`: dollar delta between `hold` and `sellNowInvest`.\n- `bracketJump`: fromRate, toRate, thresholdAtJump describing the marginal bracket change at exercise.\n\nExample call: {shares: 5000, strike: 10, currentPrice: 50, ordinaryIncome: 180000, filingStatus: "single", stateCode: "CA", stillEmployed: true, holdYears: 2, volatility: 0.3, holdFunding: "cash", ticker: "AAPL"}.' + STRICT_INPUT_NOTE,
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
          description: 'Non-qualified Stock Option (NSO) shares to exercise.' + USER_FACT,
        },
        strike: {
          type: 'number',
          minimum: 0,
          description: 'Strike price per share, USD.' + USER_FACT,
        },
        currentPrice: {
          type: 'number',
          minimum: 0,
          description:
            'Current fair market value per share, USD. The bargain element at exercise is shares × (currentPrice − strike).' + USER_FACT,
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description:
            'Annual ordinary income before this exercise, USD. Baseline for the bracket walk on the bargain element.' + USER_FACT + TAXABLE_INCOME_NOTE,
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
            'Years to hold after exercise (minimum 1). At ≥1 year, the appreciation since exercise is LTCG; sub-1-year holds are out of scope.' + PLANNING_CHOICE,
        },
        expectedSalePrice: {
          type: ['number', 'string'],
          minimum: 0,
          description:
            'Projected $/share at end of holdYears, or the string "market" to project currentPrice at the S&P 500 trailing average when the user has no view. Required unless `ticker` resolves it from currentPrice × (1 + trailing CAGR)^holdYears. This tool has no default for it: a value not stated by the user, not resolved by a covered `ticker`, and not the "market" sentinel is outside the input contract.',
        },
        volatility: VOLATILITY_SCHEMA,
        haircut: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Alternative to `volatility`: the multiplicative volatility-drag haircut on expectedSalePrice already computed for the hold. Supply this OR `volatility` (if both are given, haircut wins). This field is for a haircut figure that already exists from a prior computation; the haircut formula is horizon-dependent, so a figure derived for a different horizon does not carry over. Supplying `volatility` instead lets the tool derive it.',
        },
        expectedMarketReturn: {
          type: ['number', 'string'],
          description:
            'Annual after-tax-proceeds reinvestment rate. Defaults to SPY trailing CAGR for holdYears if omitted; the string "market" names that same default explicitly.',
        },
        ticker: TICKER_SCHEMA,
        holdFunding: {
          type: 'string',
          enum: ['sell-to-cover', 'cash'],
          description:
            "How the strike cost and exercise tax are funded. 'sell-to-cover' sells enough shares to cover strike + tax (reduces sharesRetained). 'cash' pays strike + tax from outside funds (full sharesRetained); no extra input is needed - the result reports the outside cash required as the output field cashNeededAtExercise.",
        },
      },
    },
    outputSchema: NSO_OUTPUT_SCHEMA,
    handler: (args) => computeNsoResult(parseNsoInput(args)),
  },
  {
    name: 'rsu_sell_vs_hold',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'RSU Sell-at-Vest vs Hold', ...CALC_HINTS },
    description:
      'Use this when someone asks whether to sell RSUs at vest or hold them, whether to sell their vested shares or diversify out of company stock, or about the tax and withholding on a restricted stock unit (RSU) vest. After-tax RSU vest analysis: sell-at-vest vs hold-to-long-term-capital-gains (LTCG) over `holdYears`. Covers federal ordinary tax, state tax, FICA (Social Security + Medicare + Additional Medicare), and the shortfall between mandatory 22% supplemental withholding and the user\'s marginal bracket. Use for RSUs at vest; for ISO/AMT use `amt_iso_optimize`, for NSO use `nso_calculate`. Deterministic and offline; tax tables compiled in. Returns `vest`, `hold`, `sellNowInvest`, `holdMinusSell`, and `bracketJump`; see `outputSchema` for the full shape. Example call: {shares: 1000, currentPrice: 100, ordinaryIncome: 200000, filingStatus: "single", stateCode: "CA", stillEmployed: true, holdYears: 2, volatility: 0.3, ticker: "MSFT"}.' + STRICT_INPUT_NOTE,
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
          description: 'Restricted Stock Unit (RSU) shares vesting in this tranche.' + USER_FACT,
        },
        currentPrice: {
          type: 'number',
          minimum: 0,
          description:
            'Fair market value per share at vest, USD. Also the cost basis on retained shares.' + USER_FACT,
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description: 'Annual ordinary income before this vest, USD. Baseline for the bracket walk on the vest amount.' + USER_FACT + TAXABLE_INCOME_NOTE,
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
            'Years to hold after vest (0.25..5). Below 1 year triggers the short-term capital gains cliff (ordinary rates on appreciation).' + PLANNING_CHOICE,
        },
        expectedSalePrice: {
          type: ['number', 'string'],
          minimum: 0,
          description:
            'Projected $/share at end of holdYears, or the string "market" to project currentPrice at the S&P 500 trailing average when the user has no view. Required unless `ticker` resolves it from currentPrice × (1 + trailing CAGR)^holdYears. This tool has no default for it: a value not stated by the user, not resolved by a covered `ticker`, and not the "market" sentinel is outside the input contract.',
        },
        volatility: VOLATILITY_SCHEMA,
        haircut: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Alternative to `volatility`: the multiplicative volatility-drag haircut on expectedSalePrice already computed for the hold. Supply this OR `volatility` (if both are given, haircut wins). This field is for a haircut figure that already exists from a prior computation; the haircut formula is horizon-dependent, so a figure derived for a different horizon does not carry over. Supplying `volatility` instead lets the tool derive it.',
        },
        expectedMarketReturn: {
          type: ['number', 'string'],
          description:
            'Annual after-tax-proceeds reinvestment rate. Defaults to SPY trailing CAGR for holdYears if omitted; the string "market" names that same default explicitly.',
        },
        ticker: TICKER_SCHEMA,
      },
    },
    outputSchema: RSU_OUTPUT_SCHEMA,
    handler: (args) => computeRsuResult(parseRsuInput(args)),
  },
  {
    name: 'concentration_analyze',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'Single-Stock Concentration Analysis', ...CALC_HINTS },
    description:
      'Use this when someone asks how risky a large single-stock position is, whether too much of their net worth is in one stock, whether they are over-concentrated in a single name, or how to reduce or diversify a concentrated position. Single-stock concentration risk analysis on an existing position. For standalone hedge pricing use `protective_put_price`; for the tax math on the option exercise or RSU vest that created the concentration, route to `amt_iso_optimize` / `nso_calculate` / `rsu_sell_vs_hold` first. Quantifies drawdown exposure at 30/50/70% downside, then compares three after-tax strategies over a three-year horizon (sell-down to target weight, hold, hedge with put or zero-cost collar), accounting for federal LTCG, state tax, the 3.8% Net Investment Income Tax (NIIT), and reinvestment opportunity cost. `totalAssets` (concentrated position + everything else) frames risk relative to the whole portfolio. Returns a top-level object with keys: `concentration` (position/totalAssets), `riskBand` (Low / Moderate / Concentrated / Highly concentrated / Extreme), `isLongTermToday`, `longTermDate`, `daysUntilLongTerm`, `lossExposure` ({drop, dollarLoss, newConcentration} for 30/50/70% drops), `waitForLtInsight`, `schedule` (yearly sales with per-year tax), `hedging` ({kind, protectionLevel, tenorYears, strike, putPrice, callStrike, callPrice, netPremium, sigma, riskFreeRate} - a 1-year 30%-OTM put by default, or the structure named by `hedgeChoice`), `sectorContextLine`, `advisorBenchmarkLine`. Example call: {positionValue: 400000, costBasis: 100000, acquisitionDate: "2022-01-01", sector: "tech_software", stateCode: "CA", filingStatus: "single", ordinaryIncome: 200000, totalAssets: 1200000, volatility: 0.45, ticker: "NVDA"}.' + STRICT_INPUT_NOTE,
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
          description: 'Current market value of the concentrated single-stock position, USD.' + USER_FACT,
        },
        costBasis: {
          type: 'number',
          minimum: 0,
          description:
            'Total cost basis of the position, USD (sum of strikes paid + ordinary-income inclusions on RSU vest / NSO exercise / disqualified ISO).' + USER_FACT,
        },
        acquisitionDate: {
          ...ISO_DATE,
          description:
            'Earliest acquisition date in the lot (YYYY-MM-DD). Drives the 1-year LTCG threshold and the long-term-vs-short-term tax routing.',
        },
        sector: {
          ...SECTOR_SCHEMA,
          description:
            'Sector tag. Drives the default volatility used in the hedge-cost computation when no explicit volatility is provided (a sector-typical implied volatility).',
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
          description: 'Annual ordinary income before any sales, USD. Baseline for LTCG bracket determination.' + USER_FACT + TAXABLE_INCOME_NOTE,
        },
        totalAssets: {
          type: 'number',
          minimum: 0,
          description:
            'Total investable portfolio in dollars (concentrated position + everything else). This value must come from the user, never inferred; if the user did not state it, ask.',
        },
        expectedPositionReturn: {
          type: ['number', 'string'],
          description:
            'Annual expected return on the concentrated stock as a decimal (0.10 = 10%), or the string "market" to use the S&P 500 trailing average when the user has no view. Required unless `ticker` resolves it from trailing CAGR. This tool has no default for it: a value not stated by the user, not resolved by a covered `ticker`, and not the "market" sentinel is outside the input contract.',
        },
        expectedMarketReturn: {
          type: ['number', 'string'],
          description:
            'Annual after-tax-proceeds reinvestment rate. Defaults to SPY trailing CAGR for the 3-year horizon if omitted; the string "market" names that same default explicitly.',
        },
        ticker: TICKER_SCHEMA,
        volatility: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description:
            'Annualized volatility (sigma) of the stock as a decimal (0.72 = 72%). Pass the volatility itself, not a pre-computed drag: the tool uses it both for hedge pricing (as implied vol) and for the 3y horizon drag, derived internally (the drag formula is horizon-dependent). This value must come from the user or from a `ticker` that resolves it from the cached implied-vol table; if neither supplies it, ask the user rather than estimating one; only as a last fallback does hedge pricing use a sector-typical implied volatility.',
        },
        volatilityDrag: {
          type: 'number',
          minimum: 0,
          maximum: 0.99,
          description:
            'Alternative to `volatility`: the multiplicative price haircut already computed for the horizon. Supply this OR `volatility` (if both are given, volatilityDrag wins). This field is for a drag figure that already exists from a prior computation; the drag formula is horizon-dependent, so a figure derived for a different horizon does not carry over. Supplying `volatility` instead lets the tool derive it.',
        },
        hedgeChoice: {
          type: 'object',
          required: ['kind', 'protectionLevel', 'tenorYears'],
          description:
            'Optional hedge specification. When supplied, the `hedging` output block prices this exact structure (kind, protectionLevel, tenorYears, plus a short call for a collar) instead of the default 1-year 30%-OTM put; the sell-down-vs-hold schedule is unaffected. For full standalone hedge pricing (protective put / collar / put spread) use `protective_put_price`.',
          properties: {
            kind: {
              type: 'string',
              enum: ['put', 'collar'],
              description:
                "Hedge instrument: 'put' (bare protective put, pay premium for downside protection) or 'collar' (put financed by a short call, caps upside in exchange for lower or zero net premium).",
            },
            protectionLevel: {
              type: 'number',
              minimum: 0.05,
              maximum: 0.5,
              description: 'Put strike chosen as (1 − this fraction) × spot. 0.10 = 10% OTM put. Range 0.05..0.50.' + PLANNING_CHOICE,
            },
            tenorYears: {
              type: 'number',
              minimum: 0.25,
              description: 'Option tenor in years. 1 = 12-month; 0.25 = ~90-day.' + PLANNING_CHOICE,
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
    outputSchema: CONCENTRATION_OUTPUT_SCHEMA,
    handler: (args) => computeConcentration(parseConcentrationInput(args)),
  },
  {
    name: 'protective_put_price',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'Protective Put / Collar / Put Spread Pricing', ...CALC_HINTS },
    description:
      'Use this when someone asks how much it costs to hedge or protect a stock position against a drop, to protect gains, get downside protection, or insure a position, or to price a protective put, a zero-cost collar, or a put spread. Closed-form pricing of a protective put, a zero-cost collar, and a put spread on a single-stock position. Use for standalone hedge pricing on a single-stock position; for concentration-vs-hedge tax-cost comparison, use `concentration_analyze` with a `hedgeChoice`. Parameter interactions: `volatility` omitted falls back to a sector-typical implied volatility; an explicit sigma overrides it. For collars, omitting `upsideCapPct` lets the tool back-solve the cap that zeros the net premium (truly zero-cost collar); supplying `upsideCapPct` overrides the solver and yields a non-zero net premium when the cap is wider than zero-cost. `tenorYears` drives the risk-free-rate lookup AND the floor-hit / cap-hit probability metrics, so changing tenor shifts every probability output even at fixed strike. `expectedReturn` affects only the probability metrics (real-world drift in the floor-hit / cap-hit calculations); premium math is risk-neutral and ignores it (default 0). `protectionLevel` sets the put strike as `(1 − protectionLevel) × spot`; raising it widens the protected zone but raises premium roughly linearly. `spreadRiskLevel` (default 0.10) sets the put spread\'s short strike by targeting the probability the stock ends below it; it affects only the `putSpread` block. The put spread finances the same floor with a short put at a lower strike (not a short call), so it is cheaper than the bare put and needs no shares to sell calls against, which makes it the one structure of the three that works on unexercised employee options; the trade-off is that protection stops at the short strike and losses resume below it. Closed-form, deterministic, offline: sector volatility table and risk-free-rate curve compiled in. Reports annualized hedge cost as a percentage of position value, maximum loss with the hedge in place, upside-participation cap (collar only, since the short call offsets the long put premium), and probability of hitting the protection floor over the tenor. Returns a top-level object with keys: `inputs` (echoed canonical input), `riskFreeRate` (used in option pricing), `realWorldDrift` (from expectedReturn), `barePut` (strike, premium, annualCost, annualCostPct, maxLoss, badYearPrice, badYearDropPct, coveredLossAtBadYear, premiumToCoveredRatio, expectedProfit, premiumToExpectedProfitRatio), `collar` (putStrike, callStrike, netPremium, annualCost, annualCostPct, maxLoss, upsideCap, upsideCapPct, isZeroCost, capProbability), `putSpread` (available, unavailableReason, longStrike, longPremium, shortStrike, shortPremium, shortSigma, netPremium, annualCost, annualCostPct, maxLossInBand, bandWidth, shortStrikeDropPct, breachProbability, riskLevel, savingsPct, coveredLossAtBadYear), `payoffTable`, `payoffRange`, and `recommended` (the cleanest of collar / bare put / put spread given the inputs, or none). The `barePut`, `collar`, and `putSpread` blocks are always returned regardless of caller preference. When `putSpread.available` is false, `putSpread.unavailableReason` explains why that structure could not be priced. Example call: {positionValue: 400000, sector: "tech_software", protectionLevel: 0.10, tenorYears: 1, spreadRiskLevel: 0.10}.' + STRICT_INPUT_NOTE_NO_TICKER,
    inputSchema: {
      type: 'object',
      required: ['positionValue', 'sector', 'protectionLevel', 'tenorYears'],
      properties: {
        positionValue: {
          type: 'number',
          minimum: 0,
          description:
            'Market value of the underlying single-stock position, USD. Premium and max-loss scale linearly with this.' + USER_FACT,
        },
        sector: {
          ...SECTOR_SCHEMA,
          description:
            'Sector tag. Drives the default volatility when no explicit `volatility` is supplied (a sector-typical implied volatility).',
        },
        volatility: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description:
            'Annualized implied volatility (sigma) of the stock. Resolution order: (1) explicit `volatility` if passed; (2) cached implied vol if `ticker` is covered; (3) sector-typical IV as last fallback. An explicit value must come from the user; otherwise set a covered `ticker`, or omit and let the sector default apply.',
        },
        ticker: {
          type: 'string',
          description:
            'Optional public-stock symbol (e.g. "NVDA"). When set without an explicit `volatility`, the tool substitutes the ticker\'s cached implied vol. Unknown tickers fall through to the sector default. Echoed to `tickerLabel` in the response.',
        },
        protectionLevel: {
          type: 'number',
          minimum: 0.05,
          maximum: 0.5,
          description: 'Put strike as (1 − this fraction) × spot. 0.10 = 10% OTM put. Range 0.05..0.50.' + PLANNING_CHOICE,
        },
        tenorYears: {
          type: 'number',
          minimum: 0.25,
          description: 'Option tenor in years. 1 = 12-month; 0.25 = ~90-day.' + PLANNING_CHOICE,
        },
        expectedReturn: {
          type: 'number',
          description:
            'Annual expected stock return (decimal). Drives the real-world drift in the cap-hit / floor-hit probability metrics. Does not affect premium math. Default 0.',
        },
        spreadRiskLevel: {
          type: 'number',
          minimum: 0.01,
          maximum: 0.2,
          description:
            'Put-spread floor breach risk: target probability the stock ENDS below the spread\'s short (lower) strike at expiration. Presets 0.20 / 0.10 / 0.05 / 0.01 ("1 in 5 / 10 / 20 / 100"); off-preset values snap to the nearest. A lower value pushes the short strike deeper, widening the protected band and raising the net premium toward the bare put. Only affects the `putSpread` block. Default 0.10.',
        },
        tickerLabel: {
          type: 'string',
          description: 'Optional display string echoed back in the result. Not used in pricing.',
        },
      },
    },
    outputSchema: PROTECTIVE_PUT_OUTPUT_SCHEMA,
    handler: (args) => calculateProtectivePut(parseProtectivePutInput(args)),
  },
  {
    name: 'qsbs_check',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'QSBS Qualification Check', ...CALC_HINTS },
    description:
      'Use this when someone asks whether stock qualifies for the qualified small business stock (QSBS) / Section 1202 gain exclusion, whether their startup stock can be sold tax-free, about the 5-year QSBS holding period, or how much of the gain would be federal-tax-free. Section 1202 Qualified Small Business Stock (QSBS) qualification check. Use this tool for §1202 / QSBS qualification. For AMT timing on the ISO exercise that produced the QSBS holding, use `amt_iso_optimize` first. Parameter interactions: `entityType="other"` short-circuits the verdict to `disqualified` regardless of other fields; `acquisitionMethod="secondary"` does the same; `assetCategory="over-75m"` likewise fails immediately. Under `acquisitionMethod="gift-or-inheritance"` the holding period tacks from the original holder, so supply that earlier date as `acquisitionDate` if known. `acquisitionDate` drives era classification independent of holding period: before 2009-02-17 caps exclusion at 50%, 2009-02-17 to 2010-09-27 at 75%, 2010-09-28 through 2025-07-04 reaches 100% after a 5-year hold (pre-OBBBA), and 2025-07-05 onward uses the OBBBA tiered schedule (50% at 3y, 75% at 4y, 100% at 5y). The per-issuer exclusion cap is `max($10M, 10 × adjustedBasis)` ($15M base for stock acquired after July 4, 2025); when `expectedGain` exceeds it, the overage is fully taxable and the response surfaces `taxableGain` for that delta. `industry` is the dominant industry (>80% revenue) when the corp operates in multiple. Evaluates the six statutory tests: domestic C-corporation entity, original-issuance acquisition method, gross assets at issuance (under $50M / $50-75M / over $75M tiered cap), qualified-trade-or-business industry, active-business posture (80% asset use), and holding period (3 / 4 / 5-year tiers under OBBBA). Pure stateless check: no filing, reporting, or IRS lookup happens; the six tests are evaluated against the bundled OBBBA 2026 rule set and per-state conformity table. Returns a top-level object with keys: `verdict` (qualifies / partial / too-soon / caveats / disqualified), `exclusionPercent` (0..1), `perIssuerCap` and `tenXBasisCap` (the two cap inputs), `applicableCap` (max of the two), `excludableGain`, `taxableGain`, `federalTaxSaved` (LTCG bracket on the excluded gain), `stateConforms` (full / partial / none) and `stateNote` (per-state explanation), `holdingYears`, `yearsUntilFullExclusion`, `era` (pre-2009 / pre-2010 / pre-obbba / obbba), and `tests` (array of {id, label, status, detail} for each of the six statutory tests, identifying any gate that failed). Example call: {acquisitionDate: "2020-01-15", saleDate: "2026-06-01", entityType: "us-c-corp", acquisitionMethod: "original-issuance", assetCategory: "under-50m", industry: "tech-software", activeBusiness: "yes", adjustedBasis: 100000, expectedGain: 5000000, stateCode: "CA", ordinaryIncome: 250000, filingStatus: "single"}.' + STRICT_INPUT_NOTE_NO_TICKER + QSBS_UNSURE_NOTE,
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
            'Date the QSBS shares were acquired (YYYY-MM-DD). Drives the holding-period test and the era classification (50% pre-2009 era, 75% pre-2010 era, 100% after a 5-year hold for acquisitions from 2010-09-28 through 2025-07-04, OBBBA tiered after 2025-07-05).',
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
            '§1202 Test 4: Industry classification of the corporation. Four values qualify: tech-software, manufacturing, biotech-research, retail-wholesale. Specified service trades or businesses (law, engineering, architecture, accounting-actuarial, consulting, finance, health-services, performing-arts) do NOT qualify, and farming, extraction and hospitality are separately excluded, so they do not qualify either. other-services and unsure return a caveated verdict rather than a pass or fail.',
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
            "Adjusted basis of the QSBS shares, USD. Used in the 10× basis cap: the per-issuer exclusion cap is max($10M, 10 × adjustedBasis)." + USER_FACT,
        },
        expectedGain: {
          type: 'number',
          description:
            'Expected total gain on sale, USD. Compared against the per-issuer exclusion cap to compute excludableGain and taxableGain.' + USER_FACT,
        },
        stateCode: {
          ...STATE_SCHEMA,
          description:
            'Two-letter US state code. Drives the state-conformity verdict: CA/AL/PA/MS do not conform (full state tax owed); HI/MA partial; NJ 2026-01-01 conformity switch; most others fully conform.',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description: 'Annual ordinary income, USD. Baseline for the federal LTCG bracket on any taxable gain.' + USER_FACT + TAXABLE_INCOME_NOTE,
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description: 'Federal filing status. Drives the LTCG bracket on any non-excluded gain and the NIIT MAGI threshold.',
        },
      },
    },
    outputSchema: QSBS_OUTPUT_SCHEMA,
    handler: (args) => evaluateQsbs(parseQsbsInput(args)),
  },
  {
    name: 'equity_funding_plan',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'Equity-Funding Plan Comparison', ...CALC_HINTS },
    description:
      'Use this when someone asks which shares to sell and when to reach a cash goal by a deadline (down payment, tuition, a tax bill), or how to fund a goal from equity with the least tax. Multi-year, multi-stack equity-funding optimizer. Given a target after-tax amount and a deadline (down payment, tax bill, expansion check), returns four named plans on the risk/wealth frontier: `lockInNow` (sell today, zero price risk), `balanced` (bracket-aware spread across months), `holdForGrowth` (sell at the deadline, max upside), and `recommended` (the wealth-maximal plan whose lognormal shortfall is at or below `riskToleranceShortfall`, default 10%). Also returns `frontier`, the full hybrid sweep between Lock-in-now and Balanced. Each plan carries its `plan` schedule plus `wealthAtTarget`, `totalTax`, and `shortfallProbability`; see `outputSchema` for the full shape. Use this when an equity holder needs cash by a deadline; for the upstream tax math on RSU/NSO/ISO events that PRODUCED the holdings, call `rsu_sell_vs_hold` / `nso_calculate` / `amt_iso_optimize` first. Out of scope: FICA, AMT, QSBS routing (use `qsbs_check`). Pass multi-ticker holdings via `stacks`; single-stack legacy callers can use top-level `lots` + `currentPrice`. Example: {targetAfterTax: 400000, targetDate: "2028-06-01", stacks: [{ticker: "NVDA", currentPrice: 140, expectedAnnualGrowth: 0.15, volatility: 0.45, lots: [{shares: 4000, costBasisPerShare: 60, acquisitionDate: "2023-06-15"}]}], ordinaryIncome: 280000, filingStatus: "married_joint", stateCode: "CA", cashInterestRate: 0.04, riskToleranceShortfall: 0.10}. Each stack needs `expectedAnnualGrowth`: a decimal, the string "market" (S&P 500 trailing average), or a covered `ticker` that resolves it from the trailing-returns table (a symbol like "NVDA" is enough; volatility still comes from the stack\'s `volatility` or `defaultVolatility`). Omitting growth is an error, not a flat default; pass 0 to model flat prices deliberately.' + STRICT_INPUT_NOTE_NO_TICKER,
    inputSchema: {
      type: 'object',
      required: ['targetAfterTax', 'targetDate', 'ordinaryIncome', 'filingStatus', 'stateCode'],
      // The "stacks OR (lots + currentPrice)" choice is enforced by
      // parseEquityFundingInput, NOT by the schema. It used to be a top-level
      // `anyOf`, which the Anthropic Messages API rejects outright:
      //   tools.6.custom.input_schema: input_schema does not support oneOf,
      //   allOf, or anyOf at the top level
      // Anthropic validates the whole tools array, so one such schema 400s the
      // ENTIRE request - all eight tools, not just this one. Any client that
      // bridges MCP tool descriptors into that API (Claude Desktop, claude.ai
      // connectors, plain SDK callers) is affected. Verified 2026-08-12: as
      // shipped 400, with this removed 200.
      // The requirement is stated in the description and returns a named-field
      // error at call time, which is where every other conditional requirement
      // in this suite is enforced too.
      properties: {
        targetAfterTax: {
          type: 'number',
          minimum: 0,
          description: 'Net cash needed in the user\'s pocket after all applicable taxes (federal LTCG/ordinary + state + NIIT), USD. Example: a $1M house with 20% down minus existing savings might give a $200,000 target.' + USER_FACT,
        },
        targetDate: {
          ...ISO_DATE,
          description: 'Date by which the user needs the net cash (YYYY-MM-DD). Bounds the planning horizon. Sales in non-target years happen on Dec 31; the target year\'s sale happens on this exact date.' + USER_FACT,
        },
        stacks: {
          type: 'array',
          minItems: 1,
          description: 'Holdings, multi-stack form. Provide either `stacks` (this) OR the legacy `lots`+`currentPrice` pair, not both. Each stack is one equity position (one ticker) with its own current price, growth, optional volatility, and lot list. Use when the user holds multiple tickers (e.g. current-employer RSUs + ETF + prior-employer holdings); the optimizer searches sales across all stacks jointly so the schedule can prefer the lowest-tax inventory in each year.',
          items: {
            type: 'object',
            required: ['currentPrice', 'lots'],
            properties: {
              ticker: { type: 'string', description: 'Optional ticker label (e.g. "NVDA"). When set without `expectedAnnualGrowth`, growth is resolved from the cached trailing-CAGR snapshot when the symbol is covered there (see the covered-tickers resource for the current set). Echoed back in each SaleEntry for display.' },
              currentPrice: { type: 'number', minimum: 0, description: '$/share today for this stack. Anchors the projected-price compounding for every future candidate sale date in this stack.' + USER_FACT },
              expectedAnnualGrowth: { type: ['number', 'string'], description: 'Per-stack growth decimal (0.08 = 8%/yr), or the string "market" for the S&P 500 trailing average. Projected sale price = currentPrice × (1 + expectedAnnualGrowth)^Δyears. Negative values model decline; pass 0 for a deliberately flat-price plan. Required unless `ticker` resolves it; omitting it is an error, not a flat default.' },
              volatility: { type: 'number', minimum: 0, maximum: 5, description: 'Per-stack annualized σ used in the shortfall calculation (σ × √Δt per sale). Overrides `defaultVolatility` for THIS stack only. Useful when one stack is a single tech name (σ ≈ 0.40-0.60) and another is an ETF (σ ≈ 0.15-0.20). Omit to inherit `defaultVolatility`.' },
              lots: {
                type: 'array',
                minItems: 1,
                description: 'Cost-basis cohorts within this stack (one per vest tranche / ESPP purchase / open-market buy).',
                items: {
                  type: 'object',
                  required: ['shares', 'costBasisPerShare', 'acquisitionDate'],
                  properties: {
                    shares: { type: 'integer', minimum: 1, description: 'Whole shares in this lot.' },
                    costBasisPerShare: { type: 'number', minimum: 0, description: '$/share basis. RSU = FMV at vest; ISO/NSO = exercise price; ESPP/open-market = purchase price.' },
                    acquisitionDate: { ...ISO_DATE, description: 'Acquisition date. Sales 366+ days later are long-term capital gains; earlier sales are short-term ordinary. Drives the LT-vs-ST classification at every candidate sale date.' },
                    vestDate: { ...ISO_DATE, description: 'Optional future vest date for an unvested RSU tranche. The lot is excluded from sales whose date precedes `vestDate`. For unvested RSUs, set `vestDate` to the future vest date and pass `costBasisPerShare: 0`; the calc overrides basis with the projected FMV at vest.' },
                  },
                },
              },
            },
          },
        },
        lots: {
          type: 'array',
          minItems: 1,
          description: 'Legacy single-stack input (v1.5 / v1.6). Provide either `stacks` (v1.7+) or these legacy fields, not both. Lot is one cost-basis cohort (one RSU vest tranche, one ESPP purchase, one open-market buy).',
          items: {
            type: 'object',
            required: ['shares', 'costBasisPerShare', 'acquisitionDate'],
            properties: {
              shares: { type: 'integer', minimum: 1, description: 'Whole shares in this lot.' },
              costBasisPerShare: {
                type: 'number',
                minimum: 0,
                description: 'Per-share cost basis, USD. For RSU vests this is the FMV at vest. For ESPP/open-market this is the purchase price.',
              },
              acquisitionDate: {
                ...ISO_DATE,
                description: 'Date the lot was acquired. Drives the 1-year long-term-vs-short-term classification at each candidate sale date.',
              },
              vestDate: { ...ISO_DATE, description: 'Optional future vest date for an unvested RSU tranche. The lot is excluded from sales whose date precedes `vestDate`. For unvested RSUs, set `vestDate` to the future vest date and pass `costBasisPerShare: 0`; the calc overrides basis with the projected FMV at vest. Same semantics as `stacks[].lots[].vestDate`.',
              },
            },
          },
        },
        currentPrice: {
          type: 'number',
          minimum: 0,
          description: 'Legacy single-stack current share price, USD. Pair with legacy `lots` (omit `stacks`). This value must come from the user.',
        },
        expectedAnnualGrowth: {
          type: ['number', 'string'],
          description: 'Legacy single-stack annual growth decimal, or the string "market" for the S&P 500 trailing average. Required with `lots`: pass 0 for a deliberately flat-price plan (omitting it is an error, not a flat default). Each future year\'s projected price is `currentPrice × (1 + expectedAnnualGrowth)^Δyears`. Negative values model decline.',
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description: 'Annual ordinary income, USD. Used as the baseline for the federal LTCG bracket walk in each candidate year and for NIIT threshold tests.' + USER_FACT + TAXABLE_INCOME_NOTE,
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description: 'Federal filing status. Drives LTCG brackets, NIIT threshold ($200K single / $250K MFJ MAGI), and state bracket lookups.',
        },
        stateCode: {
          ...STATE_SCHEMA,
          description: 'Two-letter US state code (e.g. CA, NY, TX). Drives state ordinary or LTCG treatment depending on state (CA taxes LTCG as ordinary; WA has no LTCG tax under $250K; TX/FL/etc. have no state income tax).',
        },
        cashInterestRate: {
          type: 'number',
          description: 'Annualized PRE-tax yield on cash held between each sale and the target date (money-market / short-term Treasury). The tool internally discounts this by the user\'s marginal federal + state ordinary rate before compounding, so the after-tax cash growth stays apples-to-apples with stock appreciation. Default 0 (interest ignored).',
        },
        riskToleranceShortfall: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Max acceptable P(realized cash < target) under the lognormal price model, as a fraction (0.10 = 10%). The `recommended` plan is the wealth-maximal plan whose shortfall ≤ this value. Tighter values push the recommendation toward Lock-in-now; looser values let `recommended` accept more price exposure for higher expected wealth. Default 0.10.',
        },
        defaultVolatility: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description: 'Annualized σ assumed for any stack that omits its own `volatility`. Drives the per-sale σ × √Δt shortfall calculation. Override per-stack on the stack object when one position is materially more or less volatile than the rest. Default 0.30.',
        },
      },
    },
    outputSchema: EQUITY_FUNDING_OUTPUT_SCHEMA,
    handler: (args) => computeEquityFundingComparison(parseEquityFundingInput(args)),
  },
  {
    name: 'rsu_lot_optimize',
    _meta: SCENARIO_WIDGET_META,
    annotations: { title: 'RSU Lot-Order Divest Plan', ...CALC_HINTS },
    description:
      'Use this when someone asks which vested RSU lots to sell first, in which years, to divest a concentrated company-stock position at the lowest computed tax: "I want to sell down half my Amazon stock with the smallest tax bill, which lots and when?". Given the vested lots (vest date, shares, cost basis), a current price, and a divest fraction, it chooses WHICH lots and WHICH sale dates minimize computed total tax to divest that many shares, using three levers: specific-lot identification (sell higher-basis lots to realize less gain, or underwater lots to harvest losses that net against gains), long-term deferral (wait past the one-year mark to convert short-term ordinary rates to long-term capital gains), and multi-year bracket spreading (split gains across 1 to 3 tax years, with in-plan capital-loss carryforward). Every sale is priced at today\'s price (flat-price assumption; there is no growth model). Returns the year-by-year sell schedule grouped by tax year, the total tax (federal LTCG + NIIT + state), what a first-in-first-out (FIFO) oldest-first sell order on the same schedule would have cost (`headlineDeltaVsFifo`), a 1/2/3-year horizon trade-off, and per-lot deferral callouts. This tool owns WHICH LOTS and WHICH DATES; for WHETHER and HOW MUCH to sell down a position use `concentration_analyze`, for a single new vest use `rsu_sell_vs_hold`, and to raise a specific cash amount by a deadline use `equity_funding_plan`. Out of scope: growth/return modeling, wash-sale basis migration, AMT, unvested grants. Example: {lots: [{vestDate: "2022-08-15", shares: 120, costBasisPerShare: 95}, {vestDate: "2024-02-15", shares: 100, costBasisPerShare: 130}, {vestDate: "2026-05-15", shares: 80, costBasisPerShare: 210}], currentPrice: 180, divestFraction: 0.5, horizonYears: 2, ordinaryIncome: 200000, filingStatus: "single", stateCode: "CA"}.' + STRICT_INPUT_NOTE_NO_TICKER,
    inputSchema: {
      type: 'object',
      required: ['lots', 'currentPrice', 'divestFraction', 'horizonYears', 'ordinaryIncome', 'filingStatus', 'stateCode'],
      properties: {
        lots: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_RSU_LOT_ORDER_LOTS,
          description: `The vested RSU lots still held (after any sell-to-cover), one entry per vest tranche. The tool decides which of these to sell and when. Unvested grants are out of scope. At most ${MAX_RSU_LOT_ORDER_LOTS} lots per call, the same cap the web calculator uses. With more tranches than that, combine the ones sharing a vest date and cost basis.`,
          items: {
            type: 'object',
            required: ['vestDate', 'shares', 'costBasisPerShare'],
            properties: {
              vestDate: { ...ISO_DATE, description: 'Date this lot vested (YYYY-MM-DD), on or before today. Drives long-term-vs-short-term status and the long-term-crossing sale date.' },
              shares: { type: 'number', exclusiveMinimum: 0, description: 'Shares still held from this vest. Fractional allowed (dividend-reinvest / net-settlement lots).' },
              costBasisPerShare: { type: 'number', minimum: 0, description: 'Per-share cost basis, USD: the share price on vest day, which your broker\'s lot-detail page lists.' },
            },
          },
        },
        currentPrice: {
          type: 'number',
          minimum: 0,
          description: 'Current share price, USD. Every sale, on every date, is priced at this value (flat-price assumption). This value must come from the user.',
        },
        divestFraction: {
          type: 'number',
          minimum: 0.1,
          maximum: 1,
          description: 'Fraction of TOTAL shares to divest, as a decimal (0.5 = sell half). Range 0.10 to 1.0. NOTE: a decimal fraction, NOT a percent, so pass 0.5 not 50. The tool sells round(divestFraction x totalShares) shares, floored at 1.' + PLANNING_CHOICE,
        },
        horizonYears: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'Tax years the plan may span: 1 = sell everything now, 2, or 3. More years let the plan spread gains across brackets and defer short-term lots to long-term, at the cost of staying exposed to the stock longer.' + PLANNING_CHOICE,
        },
        ordinaryIncome: {
          type: 'number',
          minimum: 0,
          description: 'Total household ordinary income for the year, USD, from all sources. Sets the federal LTCG bracket floor, the short-term ordinary rate, and the net investment income tax (NIIT) threshold test. This is taxable income after deductions, not gross wages: the engine applies no standard or itemized deduction to it. Assumed constant across plan years.' + USER_FACT,
        },
        filingStatus: {
          ...FILING_SCHEMA,
          description: 'Federal filing status. Drives LTCG brackets, the NIIT threshold, and state bracket lookups.',
        },
        stateCode: {
          ...STATE_SCHEMA,
          description: 'Two-letter US state code (e.g. CA, NY, TX). Drives state capital-gains treatment (CA taxes gains as ordinary; WA/TX/FL have no tax on most capital gains).',
        },
      },
    },
    outputSchema: RSU_LOT_OPTIMIZE_OUTPUT_SCHEMA,
    handler: (args) => computeLotDivestPlan(parseRsuLotOptimizeInput(args)),
  },
];

// Canonical published tool spec (public/toolspec.json in both repos), derived
// 1:1 from TOOLS so the duplicated mirror cannot silently desync. `outputSchema`
// and `handler` are intentionally omitted (toolspec is the lighter, input-facing
// surface). Regenerate the on-disk copies with `npm run gen:toolspec`; the
// drift guard is tests/toolspec-generated.test.ts.
export function buildToolSpec(): { tools: Array<Pick<McpTool, 'name' | 'description' | 'inputSchema' | 'annotations'>> } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  };
}

/** Canonical tool names as a set, for isToolName. Derived from TOOLS so it can
 *  never disagree with what the server actually serves. */
export const TOOL_NAMES: ReadonlySet<string> = new Set<string>(TOOLS.map((t) => t.name));
