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
import type {
  EquityFundingComparisonInput,
  EquityFundingLot,
  EquityFundingStack,
} from '../../lib/calc/equityFunding';

import { asObject, p, FILING_STATUSES, type Obj } from './api';
import { getTrailingReturn } from '../../lib/data/trailing-returns';
import { SECTOR_STATS, type SectorKey } from '../../lib/markets/sector-stats';
import { HORIZON_YEARS as CONCENTRATION_HORIZON_YEARS, IV_OVER_RV_MULTIPLIER } from '../../lib/calc/concentration';

const ASK_USER_HINT =
  'The model invoking this tool MUST NOT invent this value — ask the user.';

function resolveGrowthRate(o: Obj, fieldName: string, horizonYears: number): number {
  if (o[fieldName] !== undefined) return p.num(o, fieldName);
  if (o.ticker !== undefined) {
    const ticker = p.str(o, 'ticker');
    const r = getTrailingReturn(ticker, horizonYears);
    if (r !== null) return r;
    throw new Error(
      `field "${fieldName}" required: ticker "${ticker}" is not in our trailing-returns table (~90 covered). Pass "${fieldName}" explicitly or use a covered public-stock symbol. ${ASK_USER_HINT}`,
    );
  }
  throw new Error(
    `field "${fieldName}" required: pass a decimal annual rate (e.g. 0.10 for 10%) or set "ticker" to a covered public-stock symbol (e.g. "NVDA") to derive from trailing returns. ${ASK_USER_HINT}`,
  );
}

// Resolve the market-comparison return — defaults to SPY's horizon-blended
// trailing CAGR. Unlike position return, market return isn't user-belief-
// dependent, so a documented default is reasonable.
function resolveMarketReturn(o: Obj, horizonYears: number): number {
  if (o.expectedMarketReturn !== undefined) return p.num(o, 'expectedMarketReturn');
  const spy = getTrailingReturn('SPY', horizonYears);
  if (spy === null) {
    throw new Error(
      `field "expectedMarketReturn" required: SPY default lookup failed for ${horizonYears}y. Pass "expectedMarketReturn" explicitly.`,
    );
  }
  return spy;
}

function resolveExpectedSalePrice(o: Obj, currentPrice: number, holdYears: number): number {
  if (o.expectedSalePrice !== undefined) return p.num(o, 'expectedSalePrice');
  if (o.ticker !== undefined) {
    const ticker = p.str(o, 'ticker');
    const r = getTrailingReturn(ticker, holdYears);
    if (r !== null) return currentPrice * Math.pow(1 + r, holdYears);
    throw new Error(
      `field "expectedSalePrice" required: ticker "${ticker}" is not in our trailing-returns table (~90 covered). Pass "expectedSalePrice" explicitly or use a covered public-stock symbol. ${ASK_USER_HINT}`,
    );
  }
  throw new Error(
    `field "expectedSalePrice" required: pass the projected $/share at end of holdYears, or set "ticker" to a covered public-stock symbol to derive from currentPrice × (1 + trailing CAGR)^holdYears. ${ASK_USER_HINT}`,
  );
}

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
  const horizon = p.num(o, 'horizon');
  return {
    shares: p.num(o, 'shares'),
    strike: p.num(o, 'strike'),
    fmv: p.num(o, 'fmv'),
    expectedGrowth: resolveGrowthRate(o, 'expectedGrowth', horizon),
    volatilityDrag: p.num(o, 'volatilityDrag'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    stateCode: p.str(o, 'stateCode'),
    carryforwardCredit: p.num(o, 'carryforwardCredit'),
    horizon,
    cashReturnRate: p.num(o, 'cashReturnRate'),
    grantDate: p.date(o, 'grantDate'),
    hasLeftCompany: p.bool(o, 'hasLeftCompany'),
    terminationDate: p.optDate(o, 'terminationDate'),
  };
}

export function parseNsoInput(raw: unknown): NsoInput {
  const o = asObject(raw);
  const currentPrice = p.num(o, 'currentPrice');
  const holdYears = p.num(o, 'holdYears');
  return {
    shares: p.num(o, 'shares'),
    strike: p.num(o, 'strike'),
    currentPrice,
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
    stillEmployed: p.bool(o, 'stillEmployed'),
    holdYears,
    expectedSalePrice: resolveExpectedSalePrice(o, currentPrice, holdYears),
    haircut: p.num(o, 'haircut'),
    expectedMarketReturn: resolveMarketReturn(o, holdYears),
    holdFunding: p.enum(o, 'holdFunding', HOLD_FUNDING),
  };
}

export function parseRsuInput(raw: unknown): RsuInput {
  const o = asObject(raw);
  const currentPrice = p.num(o, 'currentPrice');
  const holdYears = p.num(o, 'holdYears');
  return {
    shares: p.num(o, 'shares'),
    currentPrice,
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
    stillEmployed: p.bool(o, 'stillEmployed'),
    holdYears,
    expectedSalePrice: resolveExpectedSalePrice(o, currentPrice, holdYears),
    haircut: p.num(o, 'haircut'),
    expectedMarketReturn: resolveMarketReturn(o, holdYears),
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
    expectedPositionReturn: resolveGrowthRate(o, 'expectedPositionReturn', CONCENTRATION_HORIZON_YEARS),
    expectedMarketReturn: resolveMarketReturn(o, CONCENTRATION_HORIZON_YEARS),
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
  const sector = p.enum(o, 'sector', SECTORS) as SectorKey;
  const volatility = o.volatility !== undefined
    ? p.num(o, 'volatility')
    : SECTOR_STATS[sector].annualVol * IV_OVER_RV_MULTIPLIER;
  const base: ProtectivePutInputs = {
    positionValue: p.num(o, 'positionValue'),
    sector,
    volatility,
    protectionLevel: p.num(o, 'protectionLevel'),
    tenorYears: p.num(o, 'tenorYears'),
  };
  if (o.expectedReturn !== undefined) base.expectedReturn = p.num(o, 'expectedReturn');
  if (o.tickerLabel !== undefined) base.tickerLabel = p.str(o, 'tickerLabel');
  return base;
}

// Resolve a per-stack annual growth rate: explicit `expectedAnnualGrowth`
// wins; else fall back to the stack's `ticker` resolved against trailing
// returns over the horizon from today → targetDate. Throws with the
// standard "field required" error pattern when neither yields a value.
function resolveStackGrowth(
  stackObj: Obj,
  stackIndex: number,
  horizonYears: number,
): number | undefined {
  if (stackObj.expectedAnnualGrowth !== undefined) return p.num(stackObj, 'expectedAnnualGrowth');
  if (stackObj.ticker !== undefined) {
    const ticker = p.str(stackObj, 'ticker');
    const r = getTrailingReturn(ticker, horizonYears);
    if (r !== null) return r;
    throw new Error(
      `field "stacks[${stackIndex}].expectedAnnualGrowth" required: ticker "${ticker}" is not in our trailing-returns table (~90 covered). Pass "expectedAnnualGrowth" explicitly or use a covered public-stock symbol. ${ASK_USER_HINT}`,
    );
  }
  // EquityFundingStack treats undefined growth as 0 (flat price). Leave
  // it undefined here so the calc applies its own default.
  return undefined;
}

function parseLot(rawLot: unknown, stackIndex: number, lotIndex: number): EquityFundingLot {
  const lot = asObject(rawLot);
  const out: EquityFundingLot = {
    shares: p.num(lot, 'shares'),
    costBasisPerShare: p.num(lot, 'costBasisPerShare'),
    acquisitionDate: p.date(lot, 'acquisitionDate'),
  };
  if (lot.vestDate !== undefined) out.vestDate = p.date(lot, 'vestDate');
  if (!Number.isFinite(out.shares) || out.shares <= 0) {
    throw new Error(`field "stacks[${stackIndex}].lots[${lotIndex}].shares" must be a positive number`);
  }
  return out;
}

export function parseEquityFundingInput(raw: unknown): EquityFundingComparisonInput {
  const o = asObject(raw);
  const targetDate = p.date(o, 'targetDate');
  const today = o.today !== undefined ? p.date(o, 'today') : new Date();
  const horizonYears = Math.max(
    0.25,
    (targetDate.getTime() - today.getTime()) / (365.25 * 86_400_000),
  );

  const stacksRaw = o.stacks;
  if (!Array.isArray(stacksRaw) || stacksRaw.length === 0) {
    throw new Error('field "stacks" must be a non-empty array');
  }

  const stacks: EquityFundingStack[] = [];
  const stackVolatilities: (number | null)[] = [];
  let anyStackVolSet = false;

  stacksRaw.forEach((rs, si) => {
    const stackObj = asObject(rs);
    const lotsRaw = stackObj.lots;
    if (!Array.isArray(lotsRaw) || lotsRaw.length === 0) {
      throw new Error(`field "stacks[${si}].lots" must be a non-empty array`);
    }
    const stack: EquityFundingStack = {
      currentPrice: p.num(stackObj, 'currentPrice'),
      lots: lotsRaw.map((rl, li) => parseLot(rl, si, li)),
    };
    if (stackObj.ticker !== undefined) stack.ticker = p.str(stackObj, 'ticker');
    const growth = resolveStackGrowth(stackObj, si, horizonYears);
    if (growth !== undefined) stack.expectedAnnualGrowth = growth;
    stacks.push(stack);

    if (stackObj.volatility !== undefined) {
      stackVolatilities.push(p.num(stackObj, 'volatility'));
      anyStackVolSet = true;
    } else {
      stackVolatilities.push(null);
    }
  });

  const out: EquityFundingComparisonInput = {
    targetAfterTax: p.num(o, 'targetAfterTax'),
    targetDate,
    stacks,
    ordinaryIncome: p.num(o, 'ordinaryIncome'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
  };
  if (o.cashInterestRate !== undefined) out.cashInterestRate = p.num(o, 'cashInterestRate');
  if (o.today !== undefined) out.today = today;
  if (o.riskToleranceShortfall !== undefined) {
    out.riskToleranceShortfall = p.num(o, 'riskToleranceShortfall');
  }
  if (o.defaultVolatility !== undefined) out.defaultVolatility = p.num(o, 'defaultVolatility');
  if (anyStackVolSet) out.stackVolatilities = stackVolatilities;
  return out;
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
