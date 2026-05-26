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

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => unknown;
};

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

export const TOOLS: McpTool[] = [
  {
    name: 'amt_iso_optimize',
    description:
      'Multi-year Incentive Stock Option (ISO) exercise schedule that minimizes federal and state Alternative Minimum Tax (AMT), with credit recovery across years, grant-expiration timing, and the post-termination exercise window. Returns the globally-optimal schedule, per-year tax breakdown, and net-final-value comparison vs lump-sum and even-split alternatives.',
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'strike', 'fmv', 'expectedGrowth', 'volatilityDrag', 'filingStatus',
        'ordinaryIncome', 'stateCode', 'carryforwardCredit', 'horizon', 'cashReturnRate',
        'grantDate', 'hasLeftCompany', 'terminationDate',
      ],
      properties: {
        shares: { type: 'integer', minimum: 1 },
        strike: { type: 'number', minimum: 0 },
        fmv: { type: 'number', minimum: 0 },
        expectedGrowth: { type: 'number' },
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
    description:
      'After-tax payout on a non-qualified stock option (NSO) exercise: federal, state, FICA (Social Security + Medicare + Additional Medicare). Compares sell-at-exercise vs hold-for-long-term-capital-gains across the chosen horizon.',
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'strike', 'currentPrice', 'ordinaryIncome', 'filingStatus', 'stateCode',
        'stillEmployed', 'holdYears', 'expectedSalePrice', 'haircut', 'expectedMarketReturn',
        'holdFunding',
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
        expectedSalePrice: { type: 'number', minimum: 0 },
        haircut: { type: 'number', minimum: 0, maximum: 1 },
        expectedMarketReturn: { type: 'number' },
        holdFunding: { type: 'string', enum: ['sell-to-cover', 'cash'] },
      },
    },
    handler: (args) => computeNsoResult(parseNsoInput(args)),
  },
  {
    name: 'rsu_sell_vs_hold',
    description:
      'Compare sell-at-vest vs hold-for-LTCG payouts for an RSU vest, including the 12-month short-term cliff, state tax, FICA, and the optional growth assumption.',
    inputSchema: {
      type: 'object',
      required: [
        'shares', 'currentPrice', 'ordinaryIncome', 'filingStatus', 'stateCode',
        'stillEmployed', 'holdYears', 'expectedSalePrice', 'haircut', 'expectedMarketReturn',
      ],
      properties: {
        shares: { type: 'integer', minimum: 1 },
        currentPrice: { type: 'number', minimum: 0 },
        ordinaryIncome: { type: 'number', minimum: 0 },
        filingStatus: FILING_SCHEMA,
        stateCode: STATE_SCHEMA,
        stillEmployed: { type: 'boolean' },
        holdYears: { type: 'number', minimum: 0.25, maximum: 5 },
        expectedSalePrice: { type: 'number', minimum: 0 },
        haircut: { type: 'number', minimum: 0, maximum: 1 },
        expectedMarketReturn: { type: 'number' },
      },
    },
    handler: (args) => computeRsuResult(parseRsuInput(args)),
  },
  {
    name: 'concentration_analyze',
    description:
      'Quantify single-stock concentration risk: drawdown exposure at 30/50/70% and after-tax comparison of selling down vs holding vs hedging, with multi-year tax math.',
    inputSchema: {
      type: 'object',
      required: [
        'positionValue', 'costBasis', 'acquisitionDate', 'sector', 'stateCode', 'filingStatus',
        'ordinaryIncome', 'totalAssets', 'expectedPositionReturn', 'expectedMarketReturn',
        'volatilityDrag',
      ],
      properties: {
        positionValue: { type: 'number', minimum: 0 },
        costBasis: { type: 'number', minimum: 0 },
        acquisitionDate: ISO_DATE,
        sector: SECTOR_SCHEMA,
        stateCode: STATE_SCHEMA,
        filingStatus: FILING_SCHEMA,
        ordinaryIncome: { type: 'number', minimum: 0 },
        totalAssets: { type: 'number', minimum: 0 },
        expectedPositionReturn: { type: 'number' },
        expectedMarketReturn: { type: 'number' },
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
    description:
      'Price a protective put or zero-cost collar on a single-stock position. Reports annual cost, max loss, upside cap, and bad-year coverage.',
    inputSchema: {
      type: 'object',
      required: ['positionValue', 'sector', 'volatility', 'protectionLevel', 'tenorYears'],
      properties: {
        positionValue: { type: 'number', minimum: 0 },
        sector: SECTOR_SCHEMA,
        volatility: { type: 'number', minimum: 0 },
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
    description:
      'Section 1202 Qualified Small Business Stock (QSBS) qualification check against the eight statutory tests. Returns verdict, exclusion percentage, federal tax saved, and state conformity under OBBBA 2026 tiered exclusion rules.',
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
