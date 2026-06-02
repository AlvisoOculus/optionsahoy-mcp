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
import { computeEquityFundingComparison } from '../../lib/calc/equityFunding';

import { FILING_STATUSES } from './api';
import {
  parseAmtIsoInput,
  parseNsoInput,
  parseRsuInput,
  parseConcentrationInput,
  parseProtectivePutInput,
  parseQsbsInput,
  parseEquityFundingInput,
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
  ' IMPORTANT: every field listed in `required` must come from the user\'s message. The model invoking this tool MUST NOT invent a value for any required field. If the user did not supply it, ask the user. For enum fields that accept `unsure`, pass `unsure` when the user does not know — do not guess yes/no.';

export const TOOLS: McpTool[] = [
  {
    name: 'amt_iso_optimize',
    annotations: { title: 'ISO/AMT Exercise Optimization', ...CALC_HINTS },
    description:
      'Multi-year Incentive Stock Option (ISO) exercise schedule that minimizes federal and state Alternative Minimum Tax (AMT), with credit recovery across years, grant-expiration timing, and the post-termination exercise window. Returns the globally-optimal schedule, per-year tax breakdown, and net-final-value comparison vs lump-sum and even-split alternatives.' + STRICT_INPUT_NOTE,
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
      'Compare sell-at-vest vs hold-for-LTCG payouts for an RSU vest, including the 12-month short-term cliff, state tax, FICA, and the optional growth assumption.' + STRICT_INPUT_NOTE,
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
      'Quantify single-stock concentration risk: drawdown exposure at 30/50/70% and after-tax comparison of selling down vs holding vs hedging, with multi-year tax math. `totalAssets` is the user\'s total investable portfolio (the concentrated position plus everything else); the analysis frames risk relative to it, so it MUST come from the user — never infer or default it.' + STRICT_INPUT_NOTE,
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
      'Price a protective put or zero-cost collar on a single-stock position. Reports annual cost, max loss, upside cap, and bad-year coverage.' + STRICT_INPUT_NOTE_NO_TICKER,
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
            'Annualized implied volatility (sigma) of the stock. Defaults to a sector-typical IV (sector_stats.annualVol × 1.20) when omitted. The model SHOULD NOT invent this — either pass an explicit value the user gave you, or omit it and let the sector default apply.',
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
      'Section 1202 Qualified Small Business Stock (QSBS) qualification check against the eight statutory tests. Returns verdict, exclusion percentage, federal tax saved, and state conformity under OBBBA 2026 tiered exclusion rules.' + STRICT_INPUT_NOTE_NO_TICKER,
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
  {
    name: 'equity_funding_optimize',
    annotations: { title: 'Equity Funding Plan', ...CALC_HINTS },
    description:
      'Multi-year, multi-stack sell-down plan for hitting a target after-tax dollar amount by a deadline (down payment, tax bill, expansion check). Inputs are one or more equity positions (stacks), each with a current price, optional ticker, and a list of cost-basis lots (with optional RSU vest dates). Returns four named plans on a risk/wealth frontier: Lock-in-now (sell today, zero price risk), Balanced (bracket-aware spread across months), Hold-for-growth (sell at target date, max upside), and the Recommended plan (highest at-target wealth among feasible plans within the user\'s shortfall tolerance). Each plan reports the schedule, total federal + state + NIIT tax, after-tax cash, retained shares, wealth at target, and lognormal shortfall probability.' + STRICT_INPUT_NOTE,
    inputSchema: {
      type: 'object',
      required: [
        'targetAfterTax', 'targetDate', 'stacks', 'ordinaryIncome', 'filingStatus', 'stateCode',
      ],
      properties: {
        targetAfterTax: { type: 'number', minimum: 0, description: 'Dollars the user needs net of all tax by the target date.' },
        targetDate: { ...ISO_DATE, description: 'Deadline by which targetAfterTax must be raised.' },
        ordinaryIncome: { type: 'number', minimum: 0, description: 'Annual W-2 / 1099 income excluding the planned sales.' },
        filingStatus: FILING_SCHEMA,
        stateCode: STATE_SCHEMA,
        cashInterestRate: {
          type: 'number',
          description: 'Annualized pre-tax yield on cash held between each sale and the target date. The calc compounds at the after-tax marginal rate. Defaults to 0 (interest ignored).',
        },
        riskToleranceShortfall: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Max acceptable P(realized cash < target) under the lognormal price model. The Recommended plan is the wealthiest feasible plan with shortfall ≤ this. Default 0.10 (10%).',
        },
        defaultVolatility: {
          type: 'number',
          minimum: 0,
          description: 'Annualized volatility used for stacks that do not specify their own. Default 0.30.',
        },
        stacks: {
          type: 'array',
          minItems: 1,
          description: 'One entry per equity position (ticker / company). Each stack carries its own current price, growth assumption, and lot list.',
          items: {
            type: 'object',
            required: ['currentPrice', 'lots'],
            properties: {
              ticker: TICKER_SCHEMA,
              currentPrice: { type: 'number', minimum: 0, description: '$/share today.' },
              expectedAnnualGrowth: {
                type: 'number',
                description: 'Decimal annual growth (0.10 = 10%/yr). Required unless `ticker` resolves it from trailing CAGR. Defaults to 0 (flat) when neither is supplied.',
              },
              volatility: {
                type: 'number',
                minimum: 0,
                description: 'Per-stack annualized σ. Overrides `defaultVolatility` for this stack\'s shortfall contribution.',
              },
              lots: {
                type: 'array',
                minItems: 1,
                description: 'Cost-basis lots. Already-vested by default; set `vestDate` to model an RSU tranche that vests in the future.',
                items: {
                  type: 'object',
                  required: ['shares', 'costBasisPerShare', 'acquisitionDate'],
                  properties: {
                    shares: { type: 'number', minimum: 1, description: 'Share count in this lot.' },
                    costBasisPerShare: { type: 'number', minimum: 0, description: '$/share basis (RSU: FMV at vest; ISO/NSO: exercise price; purchased: cost).' },
                    acquisitionDate: { ...ISO_DATE, description: 'Date used for the 12-month long-term-capital-gains clock.' },
                    vestDate: { ...ISO_DATE, description: 'Optional: future vest date for unvested RSUs. The lot is excluded from sales whose date precedes this.' },
                  },
                },
              },
            },
          },
        },
        today: { ...ISO_DATE, description: 'Optional override for "now". Defaults to the server\'s current date. Tests use this.' },
      },
    },
    handler: (args) => computeEquityFundingComparison(parseEquityFundingInput(args)),
  },
];
