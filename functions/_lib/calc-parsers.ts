// AlphaLatitude Inc. © 2026
//
// Strict input parsers shared by the REST API endpoints (functions/api/v1/*)
// and the MCP server tools (functions/_lib/mcp-tools.ts). Each takes a
// raw JSON value and returns the typed calc input, throwing
// `field "<name>" must be <X>` on validation failure (caught upstream and
// turned into either a 400 response or an MCP isError content block).

import type { AmtIsoInput } from '../../lib/calc/amtIso';
import type { NsoInput } from '../../lib/calc/nso';
import type { RsuInput } from '../../lib/calc/rsu';
import type { ConcentrationInputs } from '../../lib/calc/concentration';
import type { ProtectivePutInputs } from '../../lib/calc/protectivePut';
import type { QsbsInputs } from '../../lib/calc/qsbs';

import { asObject, p, FILING_STATUSES } from './api';

const HOLD_FUNDING = ['sell-to-cover', 'cash'] as const;
const SECTORS = [
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
] as const;
const HEDGE_KIND = ['put', 'collar'] as const;
const QSBS_ENTITY = ['us-c-corp', 'other'] as const;
const QSBS_ACQUISITION = ['original-issuance', 'gift-or-inheritance', 'secondary', 'unsure'] as const;
const QSBS_ASSET_CATEGORY = ['under-50m', '50m-to-75m', 'over-75m', 'unsure'] as const;
const QSBS_INDUSTRY = [
  'tech-software',
  'manufacturing',
  'biotech-research',
  'retail-wholesale',
  'health-services',
  'law',
  'engineering',
  'architecture',
  'accounting-actuarial',
  'consulting',
  'finance',
  'farming',
  'extraction',
  'hospitality',
  'performing-arts',
  'other-services',
  'unsure',
] as const;
const QSBS_ACTIVE_BUSINESS = ['yes', 'no', 'unsure'] as const;

export function parseAmtIsoInput(raw: unknown): AmtIsoInput {
  const o = asObject(raw);
  return {
    shares: p.num(o, 'shares'),
    strike: p.num(o, 'strike'),
    fmv: p.num(o, 'fmv'),
    expectedGrowth: p.num(o, 'expectedGrowth'),
    volatilityDrag: p.num(o, 'volatilityDrag'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    stateCode: p.str(o, 'stateCode'),
    carryforwardCredit: p.num(o, 'carryforwardCredit'),
    horizon: p.num(o, 'horizon'),
    cashReturnRate: p.num(o, 'cashReturnRate'),
    grantDate: p.date(o, 'grantDate'),
    hasLeftCompany: p.bool(o, 'hasLeftCompany'),
    terminationDate: p.optDate(o, 'terminationDate'),
  };
}

export function parseNsoInput(raw: unknown): NsoInput {
  const o = asObject(raw);
  return {
    shares: p.num(o, 'shares'),
    strike: p.num(o, 'strike'),
    currentPrice: p.num(o, 'currentPrice'),
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
    stillEmployed: p.bool(o, 'stillEmployed'),
    holdYears: p.num(o, 'holdYears'),
    expectedSalePrice: p.num(o, 'expectedSalePrice'),
    haircut: p.num(o, 'haircut'),
    expectedMarketReturn: p.num(o, 'expectedMarketReturn'),
    holdFunding: p.enum(o, 'holdFunding', HOLD_FUNDING),
  };
}

export function parseRsuInput(raw: unknown): RsuInput {
  const o = asObject(raw);
  return {
    shares: p.num(o, 'shares'),
    currentPrice: p.num(o, 'currentPrice'),
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
    stillEmployed: p.bool(o, 'stillEmployed'),
    holdYears: p.num(o, 'holdYears'),
    expectedSalePrice: p.num(o, 'expectedSalePrice'),
    haircut: p.num(o, 'haircut'),
    expectedMarketReturn: p.num(o, 'expectedMarketReturn'),
  };
}

export function parseConcentrationInput(raw: unknown): ConcentrationInputs {
  const o = asObject(raw);
  const base: ConcentrationInputs = {
    positionValue: p.num(o, 'positionValue'),
    costBasis: p.num(o, 'costBasis'),
    acquisitionDate: p.date(o, 'acquisitionDate'),
    sector: p.enum(o, 'sector', SECTORS),
    stateCode: p.str(o, 'stateCode'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    totalAssets: p.num(o, 'totalAssets'),
    expectedPositionReturn: p.num(o, 'expectedPositionReturn'),
    expectedMarketReturn: p.num(o, 'expectedMarketReturn'),
    volatilityDrag: p.num(o, 'volatilityDrag'),
  };
  if (o.volatility !== undefined) base.volatility = p.num(o, 'volatility');
  if (o.hedgeChoice !== undefined) {
    const hc = asObject(o.hedgeChoice);
    const hedge: NonNullable<ConcentrationInputs['hedgeChoice']> = {
      kind: p.enum(hc, 'kind', HEDGE_KIND),
      protectionLevel: p.num(hc, 'protectionLevel'),
      tenorYears: p.num(hc, 'tenorYears'),
    };
    if (hc.upsideCapPct !== undefined) hedge.upsideCapPct = p.num(hc, 'upsideCapPct');
    base.hedgeChoice = hedge;
  }
  return base;
}

export function parseProtectivePutInput(raw: unknown): ProtectivePutInputs {
  const o = asObject(raw);
  const base: ProtectivePutInputs = {
    positionValue: p.num(o, 'positionValue'),
    sector: p.enum(o, 'sector', SECTORS),
    volatility: p.num(o, 'volatility'),
    protectionLevel: p.num(o, 'protectionLevel'),
    tenorYears: p.num(o, 'tenorYears'),
  };
  if (o.expectedReturn !== undefined) base.expectedReturn = p.num(o, 'expectedReturn');
  if (o.tickerLabel !== undefined) base.tickerLabel = p.str(o, 'tickerLabel');
  return base;
}

export function parseQsbsInput(raw: unknown): QsbsInputs {
  const o = asObject(raw);
  return {
    acquisitionDate: p.date(o, 'acquisitionDate'),
    saleDate: p.date(o, 'saleDate'),
    entityType: p.enum(o, 'entityType', QSBS_ENTITY),
    acquisitionMethod: p.enum(o, 'acquisitionMethod', QSBS_ACQUISITION),
    assetCategory: p.enum(o, 'assetCategory', QSBS_ASSET_CATEGORY),
    industry: p.enum(o, 'industry', QSBS_INDUSTRY),
    activeBusiness: p.enum(o, 'activeBusiness', QSBS_ACTIVE_BUSINESS),
    adjustedBasis: p.num(o, 'adjustedBasis'),
    expectedGain: p.num(o, 'expectedGain'),
    stateCode: p.str(o, 'stateCode'),
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
  };
}
