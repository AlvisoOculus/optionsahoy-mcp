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

export const TOOLS: McpTool[] = [
  {
    name: 'amt_iso_optimize',
    annotations: { title: 'ISO/AMT Exercise Optimization', ...CALC_HINTS },
    description:
      'Multi-year Incentive Stock Option (ISO) exercise schedule that minimizes federal and state Alternative Minimum Tax (AMT). Models AMT credit recovery across future years, grant-expiration timing, and the post-termination exercise window. Returns the globally-optimal schedule (shares to exercise per year), per-year tax breakdown (regular tax, tentative minimum tax, AMT premium, FICA), and net final value (NFV) comparison vs lump-sum-now and even-split alternatives, all across the user-specified horizon.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'strike', 'fmv', 'volatilityDrag', 'filingStatus',
        'ordinaryIncome', 'stateCode', 'carryforwardCredit', 'horizon', 'cashReturnRate',
        'grantDate', 'hasLeftCompany', 'terminationDate',
      ],
      properties: {
        shares: { type: 'integer', minimum: 1 },
        strike: { type: 'number', minimum: 0 },
        fmv: { type: 'number', minimum: 0 },
        expectedGrowth: {
          type: 'number',
          description:
            'Annual expected stock growth as a decimal (0.10 = 10%). Required unless `ticker` resolves it from trailing CAGR.',
        },
        ticker: TICKER_SCHEMA,
        volatilityDrag: { type: 'number', minimum: 0, maximum: 0.99 },
        filingStatus: FILING_SCHEMA,
        ordinaryIncome: { type: 'number', minimum: 0 },
        stateCode: STATE_SCHEMA,
        carryforwardCredit: { type: 'number', minimum: 0 },
        horizon: { type: 'integer', minimum: 1, maximum: 10 },
        cashReturnRate: { type: 'number' },
        grantDate: ISO_DATE,
        hasLeftCompany: { type: 'boolean' },
        terminationDate: { oneOf: [ISO_DATE, { type: 'null' }] },
      },
    },
    handler: (args) => computeAmtIso(parseAmtIsoInput(args)),
  },
  {
    name: 'nso_calculate',
    annotations: { title: 'NSO Sell-vs-Hold Analysis', ...CALC_HINTS },
    description:
      'After-tax payout on a non-qualified stock option (NSO) exercise: federal, state, FICA (Social Security + Medicare + Additional Medicare). Compares sell-at-exercise vs hold-for-long-term-capital-gains across the chosen horizon.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'strike', 'currentPrice', 'ordinaryIncome', 'filingStatus', 'stateCode',
        'stillEmployed', 'holdYears', 'haircut', 'holdFunding',
      ],
      properties: {
        shares: { type: 'integer', minimum: 1 },
        strike: { type: 'number', minimum: 0 },
        currentPrice: { type: 'number', minimum: 0 },
        ordinaryIncome: { type: 'number', minimum: 0 },
        filingStatus: FILING_SCHEMA,
        stateCode: STATE_SCHEMA,
        stillEmployed: { type: 'boolean' },
        holdYears: { type: 'number', minimum: 1 },
        expectedSalePrice: {
          type: 'number',
          minimum: 0,
          description:
            'Projected $/share at end of holdYears. Required unless `ticker` resolves it from currentPrice × (1 + trailing CAGR)^holdYears.',
        },
        haircut: { type: 'number', minimum: 0, maximum: 1 },
        expectedMarketReturn: {
          type: 'number',
          description:
            'Annual after-tax-proceeds reinvestment rate. Defaults to SPY trailing CAGR for holdYears if omitted.',
        },
        ticker: TICKER_SCHEMA,
        holdFunding: { type: 'string', enum: ['sell-to-cover', 'cash'] },
      },
    },
    handler: (args) => computeNsoResult(parseNsoInput(args)),
  },
  {
    name: 'rsu_sell_vs_hold',
    annotations: { title: 'RSU Sell-at-Vest vs Hold', ...CALC_HINTS },
    description:
      'After-tax payout on a Restricted Stock Unit (RSU) vest: federal ordinary income tax, state income tax, FICA (Social Security + Medicare + Additional Medicare), and the gap between mandatory 22% federal supplemental withholding and the user\'s marginal bracket. Compares sell-at-vest vs hold-for-long-term-capital-gains (LTCG) across the chosen horizon, accounting for the 12-month short-term-vs-long-term holding threshold and the optional expected-growth assumption.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'currentPrice', 'ordinaryIncome', 'filingStatus', 'stateCode',
        'stillEmployed', 'holdYears', 'haircut',
      ],
      properties: {
        shares: { type: 'integer', minimum: 1 },
        currentPrice: { type: 'number', minimum: 0 },
        ordinaryIncome: { type: 'number', minimum: 0 },
        filingStatus: FILING_SCHEMA,
        stateCode: STATE_SCHEMA,
        stillEmployed: { type: 'boolean' },
        holdYears: { type: 'number', minimum: 0.25, maximum: 5 },
        expectedSalePrice: {
          type: 'number',
          minimum: 0,
          description:
            'Projected $/share at end of holdYears. Required unless `ticker` resolves it from currentPrice × (1 + trailing CAGR)^holdYears.',
        },
        haircut: { type: 'number', minimum: 0, maximum: 1 },
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
      'Single-stock concentration risk analysis. Quantifies drawdown exposure at 30%, 50%, and 70% downside scenarios. Compares three after-tax strategies across a three-year horizon: sell down to a target weight, hold and accept volatility, or hedge with a protective put or zero-cost collar. Computes federal long-term capital gains tax, state tax, the 3.8% Net Investment Income Tax (NIIT), and the reinvestment opportunity cost. Reports per-strategy net final value (NFV). `totalAssets` is the user\'s total investable portfolio (the concentrated position plus everything else); the analysis frames risk relative to it and MUST come from the user, never inferred.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'positionValue', 'costBasis', 'acquisitionDate', 'sector', 'stateCode', 'filingStatus',
        'ordinaryIncome', 'totalAssets', 'volatilityDrag',
      ],
      properties: {
        positionValue: { type: 'number', minimum: 0 },
        costBasis: { type: 'number', minimum: 0 },
        acquisitionDate: ISO_DATE,
        sector: SECTOR_SCHEMA,
        stateCode: STATE_SCHEMA,
        filingStatus: FILING_SCHEMA,
        ordinaryIncome: { type: 'number', minimum: 0 },
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
        volatilityDrag: { type: 'number', minimum: 0, maximum: 0.99 },
        volatility: { type: 'number', minimum: 0 },
        hedgeChoice: {
          type: 'object',
          required: ['kind', 'protectionLevel', 'tenorYears'],
          properties: {
            kind: { type: 'string', enum: ['put', 'collar'] },
            protectionLevel: { type: 'number', minimum: 0.05, maximum: 0.5 },
            tenorYears: { type: 'number', minimum: 0.25 },
            upsideCapPct: { type: 'number' },
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
      'Black-Scholes pricing of a protective put or zero-cost collar on a single-stock position. Reports annualized hedge cost as a percentage of position value, maximum loss with the hedge in place, upside participation cap (collar only, where the short call is sold to offset the long put premium), and the probability of hitting the protection floor over the chosen tenor. Uses the user-supplied annualized implied volatility (sigma) when provided; otherwise falls back to a sector-typical IV.' + STRICT_INPUT_NOTE_NO_TICKER,
    inputSchema: {
      type: 'object',
      required: ['positionValue', 'sector', 'protectionLevel', 'tenorYears'],
      properties: {
        positionValue: { type: 'number', minimum: 0 },
        sector: SECTOR_SCHEMA,
        volatility: {
          type: 'number',
          minimum: 0,
          description:
            'Annualized implied volatility (sigma) of the stock. Defaults to a sector-typical IV when omitted. The model SHOULD NOT invent this. Either pass an explicit value the user gave you, or omit it and let the sector default apply.',
        },
        protectionLevel: { type: 'number', minimum: 0.05, maximum: 0.5 },
        tenorYears: { type: 'number', minimum: 0.25 },
        expectedReturn: { type: 'number' },
        tickerLabel: { type: 'string' },
      },
    },
    handler: (args) => calculateProtectivePut(parseProtectivePutInput(args)),
  },
  {
    name: 'qsbs_check',
    annotations: { title: 'QSBS Qualification Check', ...CALC_HINTS },
    description:
      'Section 1202 Qualified Small Business Stock (QSBS) qualification check across the eight statutory tests: domestic C-corporation entity, original-issuance acquisition method, gross assets at issuance (under $50M / $50-75M / over $75M tiered cap), qualified-trade-or-business industry, active-business posture (80% asset use), holding period (3 / 4 / 5-year tiers under OBBBA), adjusted basis, and expected gain at sale. Returns the verdict (qualifies / does not qualify / partial), applicable federal exclusion percentage under the One Big Beautiful Bill Act (OBBBA) 2026 tiered regime (50% / 75% / 100%), estimated federal tax saved, and state conformity treatment (full / partial / non-conforming).' + STRICT_INPUT_NOTE_NO_TICKER,
    inputSchema: {
      type: 'object',
      required: [
        'acquisitionDate', 'saleDate', 'entityType', 'acquisitionMethod', 'assetCategory',
        'industry', 'activeBusiness', 'adjustedBasis', 'expectedGain', 'stateCode',
        'ordinaryIncome', 'filingStatus',
      ],
      properties: {
        acquisitionDate: ISO_DATE,
        saleDate: ISO_DATE,
        entityType: { type: 'string', enum: ['us-c-corp', 'other'] },
        acquisitionMethod: {
          type: 'string',
          enum: ['original-issuance', 'gift-or-inheritance', 'secondary', 'unsure'],
        },
        assetCategory: { type: 'string', enum: ['under-50m', '50m-to-75m', 'over-75m', 'unsure'] },
        industry: {
          type: 'string',
          enum: [
            'tech-software', 'manufacturing', 'biotech-research', 'retail-wholesale',
            'health-services', 'law', 'engineering', 'architecture',
            'accounting-actuarial', 'consulting', 'finance', 'farming',
            'extraction', 'hospitality', 'performing-arts', 'other-services', 'unsure',
          ],
        },
        activeBusiness: { type: 'string', enum: ['yes', 'no', 'unsure'] },
        adjustedBasis: { type: 'number', minimum: 0 },
        expectedGain: { type: 'number' },
        stateCode: STATE_SCHEMA,
        ordinaryIncome: { type: 'number', minimum: 0 },
        filingStatus: FILING_SCHEMA,
      },
    },
    handler: (args) => evaluateQsbs(parseQsbsInput(args)),
  },
];
