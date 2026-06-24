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
import { getTrailingVol } from '../../lib/data/trailing-vols';
import { SECTOR_STATS, type SectorKey } from '../../lib/markets/sector-stats';
import { HORIZON_YEARS as CONCENTRATION_HORIZON_YEARS, IV_OVER_RV_MULTIPLIER } from '../../lib/calc/concentration';
import { lognormalHaircut } from '../../lib/calc/volatility-drag';

const ASK_USER_HINT =
  'The model invoking this tool MUST NOT invent this value — ask the user.';

// Returns the cached sigma for `o.ticker`, or null when no ticker is set
// or the ticker isn't covered. Callers decide how to handle null (throw,
// or fall through to a default).
function resolveSigmaFromTicker(o: Obj): number | null {
  if (o.ticker === undefined) return null;
  return getTrailingVol(p.str(o, 'ticker'));
}

function resolveDragFromVolatility(o: Obj, dragField: string, horizonYears: number): number {
  if (o[dragField] !== undefined) return p.num(o, dragField);
  if (o.volatility !== undefined) {
    return lognormalHaircut(p.num(o, 'volatility', { min: 0 }), horizonYears);
  }
  if (o.ticker !== undefined) {
    const sigma = resolveSigmaFromTicker(o);
    if (sigma !== null) return lognormalHaircut(sigma, horizonYears);
    throw new Error(
      `field "volatility" required: ticker "${p.str(o, 'ticker')}" is not in our cached implied-vol table. Pass "volatility" explicitly (annualized sigma, e.g. 0.30 for 30%) or use a covered public-stock symbol. ${ASK_USER_HINT}`,
    );
  }
  throw new Error(
    `field "volatility" required: annualized sigma of the stock as a decimal (e.g. 0.30 for 30%). Or set "ticker" to a covered public-stock symbol (e.g. "NVDA") to derive from the cached implied-vol table. ${ASK_USER_HINT}`,
  );
}

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
  if (o.expectedSalePrice !== undefined) return p.num(o, 'expectedSalePrice', { min: 0 });
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
  const horizon = p.int(o, 'horizon', { min: 1, max: 10 });
  return {
    shares: p.int(o, 'shares', { min: 1 }),
    strike: p.num(o, 'strike', { min: 0 }),
    fmv: p.num(o, 'fmv', { min: 0 }),
    expectedGrowth: resolveGrowthRate(o, 'expectedGrowth', horizon),
    volatilityDrag: resolveDragFromVolatility(o, 'volatilityDrag', horizon),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    stateCode: p.str(o, 'stateCode'),
    carryforwardCredit: p.num(o, 'carryforwardCredit', { min: 0 }),
    horizon,
    cashReturnRate: p.num(o, 'cashReturnRate'),
    grantDate: p.date(o, 'grantDate'),
    hasLeftCompany: p.bool(o, 'hasLeftCompany'),
    terminationDate: p.optDate(o, 'terminationDate'),
  };
}

export function parseNsoInput(raw: unknown): NsoInput {
  const o = asObject(raw);
  const currentPrice = p.num(o, 'currentPrice', { min: 0 });
  const holdYears = p.num(o, 'holdYears', { min: 1 });
  return {
    shares: p.int(o, 'shares', { min: 1 }),
    strike: p.num(o, 'strike', { min: 0 }),
    currentPrice,
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
    stillEmployed: p.bool(o, 'stillEmployed'),
    holdYears,
    expectedSalePrice: resolveExpectedSalePrice(o, currentPrice, holdYears),
    haircut: resolveDragFromVolatility(o, 'haircut', holdYears),
    expectedMarketReturn: resolveMarketReturn(o, holdYears),
    holdFunding: p.enum(o, 'holdFunding', HOLD_FUNDING),
  };
}

export function parseRsuInput(raw: unknown): RsuInput {
  const o = asObject(raw);
  const currentPrice = p.num(o, 'currentPrice', { min: 0 });
  const holdYears = p.num(o, 'holdYears', { min: 0.25, max: 5 });
  return {
    shares: p.int(o, 'shares', { min: 1 }),
    currentPrice,
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
    stillEmployed: p.bool(o, 'stillEmployed'),
    holdYears,
    expectedSalePrice: resolveExpectedSalePrice(o, currentPrice, holdYears),
    haircut: resolveDragFromVolatility(o, 'haircut', holdYears),
    expectedMarketReturn: resolveMarketReturn(o, holdYears),
  };
}

export function parseConcentrationInput(raw: unknown): ConcentrationInputs {
  const o = asObject(raw);
  const base: ConcentrationInputs = {
    positionValue: p.num(o, 'positionValue', { min: 0 }),
    costBasis: p.num(o, 'costBasis', { min: 0 }),
    acquisitionDate: p.date(o, 'acquisitionDate'),
    sector: p.enum(o, 'sector', SECTORS),
    stateCode: p.str(o, 'stateCode'),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    totalAssets: p.num(o, 'totalAssets', { min: 0 }),
    expectedPositionReturn: resolveGrowthRate(o, 'expectedPositionReturn', CONCENTRATION_HORIZON_YEARS),
    expectedMarketReturn: resolveMarketReturn(o, CONCENTRATION_HORIZON_YEARS),
    volatilityDrag: resolveDragFromVolatility(o, 'volatilityDrag', CONCENTRATION_HORIZON_YEARS),
  };
  // Mirror the drag's sigma source so hedge pricing uses the same value.
  const sigma = o.volatility !== undefined ? p.num(o, 'volatility', { min: 0 }) : resolveSigmaFromTicker(o);
  if (sigma !== null) base.volatility = sigma;
  if (o.hedgeChoice !== undefined) {
    const hc = asObject(o.hedgeChoice);
    const hedge: NonNullable<ConcentrationInputs['hedgeChoice']> = {
      kind: p.enum(hc, 'kind', HEDGE_KIND),
      protectionLevel: p.num(hc, 'protectionLevel', { min: 0.05, max: 0.5 }),
      tenorYears: p.num(hc, 'tenorYears', { min: 0.25 }),
    };
    if (hc.upsideCapPct !== undefined) hedge.upsideCapPct = p.num(hc, 'upsideCapPct');
    base.hedgeChoice = hedge;
  }
  return base;
}

export function parseProtectivePutInput(raw: unknown): ProtectivePutInputs {
  const o = asObject(raw);
  const sector = p.enum(o, 'sector', SECTORS) as SectorKey;
  const sectorDefault = SECTOR_STATS[sector].annualVol * IV_OVER_RV_MULTIPLIER;
  const volatility =
    o.volatility !== undefined
      ? p.num(o, 'volatility', { min: 0 })
      : resolveSigmaFromTicker(o) ?? sectorDefault;
  const base: ProtectivePutInputs = {
    positionValue: p.num(o, 'positionValue', { min: 0 }),
    sector,
    volatility,
    protectionLevel: p.num(o, 'protectionLevel', { min: 0.05, max: 0.5 }),
    tenorYears: p.num(o, 'tenorYears', { min: 0.25 }),
  };
  if (o.expectedReturn !== undefined) base.expectedReturn = p.num(o, 'expectedReturn');
  // tickerLabel is the display surface in the response. Prefer an explicit
  // tickerLabel; fall back to `ticker` (the sigma-resolution field) so
  // callers passing only `ticker` still get it echoed back.
  if (o.tickerLabel !== undefined) {
    base.tickerLabel = p.str(o, 'tickerLabel');
  } else if (o.ticker !== undefined) {
    base.tickerLabel = p.str(o, 'ticker');
  }
  return base;
}

function parseEquityFundingLot(raw: unknown, index: number): EquityFundingLot {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`lots[${index}] must be an object with shares, costBasisPerShare, acquisitionDate`);
  }
  const o = raw as Obj;
  const lot: EquityFundingLot = {
    shares: p.int(o, 'shares', { min: 1 }),
    costBasisPerShare: p.num(o, 'costBasisPerShare', { min: 0 }),
    acquisitionDate: p.date(o, 'acquisitionDate'),
  };
  if (o.vestDate !== undefined) lot.vestDate = p.date(o, 'vestDate');
  return lot;
}

function parseEquityFundingStack(
  raw: unknown,
  index: number,
  horizonYears: number,
): { stack: EquityFundingStack; volatility: number | null } {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`stacks[${index}] must be an object with currentPrice and lots`);
  }
  const o = raw as Obj;
  const lotsRaw = o.lots;
  if (!Array.isArray(lotsRaw) || lotsRaw.length === 0) {
    throw new Error(`stacks[${index}].lots must be a non-empty array`);
  }
  const stack: EquityFundingStack = {
    currentPrice: p.num(o, 'currentPrice', { min: 0 }),
    lots: lotsRaw.map((lot, idx) => parseEquityFundingLot(lot, idx)),
  };
  if (o.ticker !== undefined) stack.ticker = p.str(o, 'ticker');
  // Growth is optional; leave undefined when neither explicit field nor ticker
  // fallback resolves it (the calc defaults to flat-price). Throw only when a
  // ticker is supplied but unknown to the trailing-returns table.
  if (o.expectedAnnualGrowth !== undefined) {
    stack.expectedAnnualGrowth = p.num(o, 'expectedAnnualGrowth');
  } else if (o.ticker !== undefined) {
    const r = getTrailingReturn(stack.ticker!, horizonYears);
    if (r === null) {
      throw new Error(
        `field "stacks[${index}].expectedAnnualGrowth" required: ticker "${stack.ticker}" is not in our trailing-returns table (~90 covered). Pass "expectedAnnualGrowth" explicitly or use a covered public-stock symbol. ${ASK_USER_HINT}`,
      );
    }
    stack.expectedAnnualGrowth = r;
  }
  // Volatility is sidecar (returned next to the stack) because the calc
  // consumes it via the parallel `stackVolatilities` array, not via a
  // per-stack field. Caller assembles the array from this stream.
  const volatility = o.volatility !== undefined ? p.num(o, 'volatility', { min: 0 }) : null;
  return { stack, volatility };
}

export function parseEquityFundingInput(raw: unknown, trustedToday?: Date): EquityFundingComparisonInput {
  const o = asObject(raw);
  const targetDate = p.date(o, 'targetDate');
  // The current date is NEVER taken from external input. A caller -- or an LLM
  // extractor with a stale training cutoff -- could otherwise set `today` and
  // anchor the entire sell schedule in the past (defect P13/RT1, hit in live
  // use). Tests pass an explicit trusted override; in production the server
  // clock is authoritative. Any `today` in the request body is ignored.
  const today = trustedToday ?? new Date();
  // Reject a deadline in the past at parse time with a clear message (RT2),
  // rather than letting it fall through to a confusing "infeasible, $0
  // achievable" result. Compare by calendar day so "fund by today" is allowed.
  const dayUTC = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (dayUTC(targetDate) < dayUTC(today)) {
    throw new Error('field "targetDate" must be today or later: the deadline is in the past.');
  }
  const horizonYears = Math.max(
    0.25,
    (targetDate.getTime() - today.getTime()) / (365.25 * 86_400_000),
  );

  const base: EquityFundingComparisonInput = {
    targetAfterTax: p.num(o, 'targetAfterTax', { min: 0 }),
    targetDate,
    today,
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.str(o, 'stateCode'),
  };
  if (o.cashInterestRate !== undefined) base.cashInterestRate = p.num(o, 'cashInterestRate');
  if (o.riskToleranceShortfall !== undefined) {
    base.riskToleranceShortfall = p.num(o, 'riskToleranceShortfall', { min: 0, max: 1 });
  }
  if (o.defaultVolatility !== undefined) base.defaultVolatility = p.num(o, 'defaultVolatility', { min: 0 });

  if (o.stacks !== undefined) {
    if (!Array.isArray(o.stacks) || o.stacks.length === 0) {
      throw new Error('field "stacks" must be a non-empty array of {currentPrice, lots[, ticker, expectedAnnualGrowth, volatility]}');
    }
    const parsed = o.stacks.map((s, idx) => parseEquityFundingStack(s, idx, horizonYears));
    base.stacks = parsed.map((p) => p.stack);
    const vols = parsed.map((p) => p.volatility);
    if (vols.some((v) => v !== null)) base.stackVolatilities = vols;
    return base;
  }

  // Legacy v1.5/v1.6 single-stack input: lots + currentPrice at top level.
  const lotsRaw = o.lots;
  if (!Array.isArray(lotsRaw) || lotsRaw.length === 0) {
    throw new Error(
      'either "stacks" (v1.7+) or legacy "lots" + "currentPrice" required',
    );
  }
  base.lots = lotsRaw.map((lot, idx) => parseEquityFundingLot(lot, idx));
  base.currentPrice = p.num(o, 'currentPrice', { min: 0 });
  if (o.expectedAnnualGrowth !== undefined) {
    base.expectedAnnualGrowth = p.num(o, 'expectedAnnualGrowth');
  }
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
    adjustedBasis: p.num(o, 'adjustedBasis', { min: 0 }),
    expectedGain: p.num(o, 'expectedGain'),
    stateCode: p.str(o, 'stateCode'),
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
  };
}
