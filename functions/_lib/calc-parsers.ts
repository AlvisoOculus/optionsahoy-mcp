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
import type { ProtectivePutInputs, VolatilitySource } from '../../lib/calc/protectivePut';
import type { QsbsInputs } from '../../lib/calc/qsbs';
import type {
  EquityFundingComparisonInput,
  EquityFundingLot,
  EquityFundingStack,
} from '../../lib/calc/equityFunding';
import type { LotDivestInput, LotDivestLot } from '../../lib/calc/lotDivest';

import { asObject, p, FILING_STATUSES, type Obj } from './api';
import { STATE_CODES } from '../../lib/tax/state-tax';
import { getTrailingReturn, hasTrailingReturn, isKnownTicker } from '../../lib/data/trailing-returns';
import { getLiveVol, VOL_UNRESOLVED_REASON } from '../../lib/data/live-vols';
import { SECTOR_STATS, type SectorKey } from '../../lib/markets/sector-stats';
import { HORIZON_YEARS as CONCENTRATION_HORIZON_YEARS, IV_OVER_RV_MULTIPLIER } from '../../lib/calc/concentration';
import { lognormalHaircut } from '../../lib/calc/volatility-drag';

// The after-tax idle-cash yield amt_iso_optimize assumes when the caller omits
// cashReturnRate (a short-Treasury-like rate). Single owner of the numeric fact:
// the Poe bot pre-fills and discloses the same value, so keep both pointed here.
export const DEFAULT_CASH_RETURN_RATE = 0.04;

// Percent-vs-decimal guardrails. Every rate field below is a DECIMAL (0.30 =
// 30%), so a value like 30 or 72 is almost certainly a percent the caller
// forgot to scale. Bounding them turns a silently-wrong result (a near-total
// volatility haircut, a 3000%/yr growth path) into a clear "must be <= N"
// error. Bounds are deliberately generous so no realistic input is refused.
const SIGMA_BOUNDS = { min: 0, max: 5 } as const; // annualized volatility (sigma)
const RATE_BOUNDS = { min: -0.9, max: 3 } as const; // annual growth / return
const CASH_RATE_BOUNDS = { min: 0, max: 1 } as const; // after-tax cash yield

// Truncate a Date to its UTC calendar day (ms at 00:00 UTC), so a date bound
// compares by day and ignores the time component. Shared by the parsers that
// bound a date to "today".
const dayUTC = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

const ASK_USER_HINT =
  'The model invoking this tool MUST NOT invent this value — ask the user.';

// Example symbols quoted in growth-field error messages so a retrying agent
// can self-serve a covered ticker without a resources/read round-trip.
// Filtered through the live table at module load: if the ETL ever drops one,
// the message self-heals instead of advertising a symbol the parser rejects.
const EXAMPLE_COVERED_TICKERS = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN']
  .filter(hasTrailingReturn)
  .join(', ');

// The growth/return fields below also accept the literal string "market":
// explicit delegation to the S&P 500 trailing blend (the same source
// expectedMarketReturn already defaults to). This is a sanctioned assumption,
// not invention — the value is deterministic and documented — so agents get a
// one-token path forward when the user has no view on growth, instead of a
// dead-end "ask the user" error. Exported so other surfaces (poe.ts's
// assumptions disclosure) test the sentinel with the same definition.
export function isMarketSentinel(v: unknown): boolean {
  return typeof v === 'string' && v.trim().toLowerCase() === 'market';
}

function marketRate(fieldName: string, horizonYears: number): number {
  const spy = getTrailingReturn('SPY', horizonYears);
  if (spy === null) {
    throw new Error(
      `field "${fieldName}": the "market" lookup (SPY trailing blend) failed for ${horizonYears}y. Pass a numeric value instead.`,
    );
  }
  return spy;
}

// Ticker-couldn't-resolve-growth error. Distinguishes a symbol that is not in
// the table at all (likely a typo or genuinely uncovered — point at examples)
// from one that IS known but too recently listed to have any trailing CAGR
// (the CRCL case — telling that caller "not in our table" sent them hunting
// for a typo that wasn't there).
function tickerGrowthError(fieldName: string, ticker: string): Error {
  const why = isKnownTicker(ticker)
    ? `ticker "${ticker}" is covered but listed too recently to have 5y/10y trailing returns`
    : `ticker "${ticker}" is not in our trailing-returns table (covered examples: ${EXAMPLE_COVERED_TICKERS}; full set in the covered-tickers resource)`;
  return new Error(
    `field "${fieldName}" required: ${why}. Pass "${fieldName}" explicitly, or pass the string "market" to use the S&P 500 trailing average. ${ASK_USER_HINT}`,
  );
}

// Returns the published sigma for `o.ticker`, or null when no ticker is set
// or the ticker resolves no CURRENT volatility. Callers decide how to handle
// null (throw, or fall through to a default).
//
// "Resolves no current volatility" is one outcome with many causes: the daily
// artifact could not be fetched, the fetch timed out, the schema is not the one
// we read, the symbol is absent, or its entry predates the last market close.
// getLiveVol collapses all of them to null on purpose — see lib/data/live-vols.
// There is no fallback source. A caller either gets a sigma as of the last
// close, or gets asked for one; it never gets a stale or estimated sigma
// dressed as a fact.
function resolveSigmaFromTicker(o: Obj): number | null {
  if (o.ticker === undefined) return null;
  return getLiveVol(p.str(o, 'ticker'));
}

function resolveDragFromVolatility(o: Obj, dragField: string, horizonYears: number): number {
  // The drag/haircut is a multiplicative fraction in [0,1]; bound it so a
  // percent (e.g. 50) is rejected rather than treated as a 5000% haircut.
  if (o[dragField] !== undefined) return p.num(o, dragField, { min: 0, max: 1 });
  if (o.volatility !== undefined) {
    return lognormalHaircut(p.num(o, 'volatility', SIGMA_BOUNDS), horizonYears);
  }
  if (o.ticker !== undefined) {
    const sigma = resolveSigmaFromTicker(o);
    if (sigma !== null) return lognormalHaircut(sigma, horizonYears);
    // No provenance field on this path: it throws rather than falling back, so
    // a drag that IS returned came from explicit-or-ticker and the caller knows
    // which. Give these tools a fallback and they get `volatilitySource` too
    // (see resolveProtectivePutSigma below).
    // WHAT THIS MUST NOT SAY: "that ticker is not in our table". Five of the
    // six ways this branch is reached (CDN timeout, non-200, unparseable body,
    // wrong schemaV, entry older than the last close) have nothing to do with
    // coverage, and an LLM handed a coverage claim relays it to the user as
    // one - telling someone their perfectly ordinary stock is unsupported
    // because a CDN blipped. The reason phrase is owned by the reader that
    // knows the failure modes (VOL_UNRESOLVED_REASON in lib/data/live-vols).
    throw new Error(
      `field "volatility" required: could not resolve a current implied volatility for ticker "${p.str(o, 'ticker')}" (${VOL_UNRESOLVED_REASON}). Pass "volatility" explicitly (annualized sigma, e.g. 0.30 for 30%) - do not invent one. ${ASK_USER_HINT}`,
    );
  }
  throw new Error(
    `field "volatility" required: annualized sigma of the stock as a decimal (e.g. 0.30 for 30%). Or set "ticker" to a public-stock symbol to resolve its implied volatility as of the last market close. ${ASK_USER_HINT}`,
  );
}

// ── The lazy-warm predicate ──────────────────────────────────────────────
// Every request handler used to `await warmVolSnapshot()` unconditionally,
// paying a cold-memo CDN fetch (up to the full timeout) on requests that
// provably cannot read the memo. This is the gate: true only when parsing
// `rawArgs` for `toolOrSlug` can actually REACH getLiveVol.
//
// Derived from the parsers above, not from intuition. The complete set of
// getLiveVol call sites in this file is resolveSigmaFromTicker, and it is
// called from exactly three places:
//
//   1. resolveDragFromVolatility - reached only when the tool's own drag field
//      is absent AND `volatility` is absent AND `ticker` is present.
//   2. parseConcentrationInput's hedge-pricing sigma - `volatility` absent AND
//      `ticker` present. NOT guarded by volatilityDrag: it is a second,
//      independent read, which is why concentration maps to `null` below.
//   3. parseProtectivePutInput's volatility - same condition as (2), with a
//      sector-typical fallback instead of a throw.
//
// So the gate is: a tool in the table, `ticker` present, `volatility` absent,
// and (where one exists) the tool's drag short-circuit absent.
//
// Tools deliberately ABSENT, each because no parser path reaches getLiveVol:
//   qsbs_check          - takes no volatility, drag or ticker field at all.
//   rsu_lot_optimize    - lot-level divest ordering; no forward projection.
//   equity_funding_plan - per-stack `ticker` resolves GROWTH only, off the
//                         baked trailing-returns table (no network, no memo).
// A tool not in the table returns false, which is the correct default: a new
// tool that wants the shortcut has to opt in here, and the behaviour test in
// tests/lazy-vol-warm.test.ts fails the day one forgets.
//
// Keys are BOTH the MCP tool name and the REST slug, because REST dispatches
// on `rest:<slug>` and A2A/Poe/stdio dispatch on the tool name.
//
// Value = the field whose presence short-circuits every ticker→sigma path in
// that parser (beyond `volatility`, which short-circuits all of them), or null
// when no such field exists.
const VOL_TICKER_SHORTCIRCUIT: Record<string, string | null> = {
  amt_iso_optimize: 'volatilityDrag',
  'amt-iso': 'volatilityDrag',
  nso_calculate: 'haircut',
  nso: 'haircut',
  rsu_sell_vs_hold: 'haircut',
  'rsu-sell-vs-hold': 'haircut',
  concentration_analyze: null,
  concentration: null,
  protective_put_price: null,
  'protective-put': null,
};

/**
 * True when parsing `rawArgs` for `toolOrSlug` could read the volatility memo,
 * i.e. when warming it can change the outcome. Handlers gate their
 * `await warmVolSnapshot()` on this.
 *
 * SAFE DIRECTION: over-approximating (returning true when the lookup would not
 * actually happen) costs a fetch. Under-approximating changes an answer. Every
 * uncertain case above therefore resolves to true, and malformed input resolves
 * to true as well when a ticker is present - the parser throws identically with
 * a cold or warm memo, so the extra warm is merely wasted, never wrong.
 */
export function mayResolveVolFromTicker(toolOrSlug: string, rawArgs: unknown): boolean {
  if (!Object.hasOwn(VOL_TICKER_SHORTCIRCUIT, toolOrSlug)) return false;
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return false;
  const o = rawArgs as Record<string, unknown>;
  // No ticker: nothing to look up. Explicit volatility: it wins on every path.
  if (o.ticker === undefined) return false;
  if (o.volatility !== undefined) return false;
  const shortCircuit = VOL_TICKER_SHORTCIRCUIT[toolOrSlug];
  return shortCircuit === null || o[shortCircuit] === undefined;
}

// One resolution ladder for every growth/return field: "market" sentinel →
// explicit number → ticker lookup → "required" error. `label` is the field
// name quoted in errors when it differs from the key read off `o` (the
// per-stack `stacks[i].expectedAnnualGrowth` case); `zeroHint` adds the
// flat-plan wording for callers whose omission used to mean a silent flat
// default.
function resolveGrowthRate(
  o: Obj,
  fieldName: string,
  horizonYears: number,
  label: string = fieldName,
  zeroHint = false,
): number {
  if (isMarketSentinel(o[fieldName])) return marketRate(label, horizonYears);
  if (o[fieldName] !== undefined) return p.num(o, fieldName, RATE_BOUNDS);
  if (o.ticker !== undefined) {
    const ticker = p.str(o, 'ticker');
    const r = getTrailingReturn(ticker, horizonYears);
    if (r !== null) return r;
    throw tickerGrowthError(label, ticker);
  }
  throw new Error(
    `field "${label}" required: pass a decimal annual rate (e.g. 0.10 for 10%${zeroHint ? ', or 0 for a deliberately flat-price plan' : ''}), set "ticker" to a covered public-stock symbol (e.g. ${EXAMPLE_COVERED_TICKERS}) to derive from trailing returns, or pass the string "market" to use the S&P 500 trailing average.${zeroHint ? ' Omitting it would silently project flat prices.' : ''} ${ASK_USER_HINT}`,
  );
}

// Resolve the market-comparison return — defaults to SPY's horizon-blended
// trailing CAGR. Unlike position return, market return isn't user-belief-
// dependent, so a documented default is reasonable. "market" is accepted for
// uniformity with the position-growth fields (it just names the default).
function resolveMarketReturn(o: Obj, horizonYears: number): number {
  if (o.expectedMarketReturn !== undefined && !isMarketSentinel(o.expectedMarketReturn)) {
    return p.num(o, 'expectedMarketReturn', RATE_BOUNDS);
  }
  return marketRate('expectedMarketReturn', horizonYears);
}

function resolveExpectedSalePrice(o: Obj, currentPrice: number, holdYears: number): number {
  if (isMarketSentinel(o.expectedSalePrice)) {
    return currentPrice * Math.pow(1 + marketRate('expectedSalePrice', holdYears), holdYears);
  }
  if (o.expectedSalePrice !== undefined) return p.num(o, 'expectedSalePrice', { min: 0 });
  if (o.ticker !== undefined) {
    const ticker = p.str(o, 'ticker');
    const r = getTrailingReturn(ticker, holdYears);
    if (r !== null) return currentPrice * Math.pow(1 + r, holdYears);
    throw tickerGrowthError('expectedSalePrice', ticker);
  }
  throw new Error(
    `field "expectedSalePrice" required: pass the projected $/share at end of holdYears, set "ticker" to a covered public-stock symbol to derive from currentPrice × (1 + trailing CAGR)^holdYears, or pass the string "market" to project currentPrice at the S&P 500 trailing average. ${ASK_USER_HINT}`,
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
  const input: AmtIsoInput = {
    shares: p.int(o, 'shares', { min: 1 }),
    strike: p.num(o, 'strike', { min: 0 }),
    fmv: p.num(o, 'fmv', { min: 0 }),
    expectedGrowth: resolveGrowthRate(o, 'expectedGrowth', horizon),
    volatilityDrag: resolveDragFromVolatility(o, 'volatilityDrag', horizon),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    stateCode: p.enum(o, 'stateCode', STATE_CODES),
    carryforwardCredit: p.optNum(o, 'carryforwardCredit', { min: 0 }) ?? 0,
    horizon,
    // Optional: the after-tax idle-cash yield that time-values the tax stream.
    // Defaults to DEFAULT_CASH_RETURN_RATE when omitted so callers are not
    // forced to supply a rate; pass an explicit value to override.
    cashReturnRate: p.optNum(o, 'cashReturnRate', CASH_RATE_BOUNDS) ?? DEFAULT_CASH_RETURN_RATE,
    grantDate: p.date(o, 'grantDate'),
    hasLeftCompany: p.bool(o, 'hasLeftCompany'),
    terminationDate: p.optDate(o, 'terminationDate'),
  };
  // The 90-day post-termination exercise window is only computed when BOTH
  // hasLeftCompany and terminationDate are present (see computeAmtIso). Without
  // the date the horizon silently caps to 1 year and the window fields return
  // null, which reads as a real "departed" answer. Fail loudly with a clear ask
  // instead of returning a misleading result.
  if (input.hasLeftCompany && input.terminationDate == null) {
    throw new Error(
      'field "terminationDate" required when hasLeftCompany=true: pass the separation date (YYYY-MM-DD); it drives the 90-day post-termination ISO exercise window. ' +
        ASK_USER_HINT,
    );
  }
  return input;
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
    stateCode: p.enum(o, 'stateCode', STATE_CODES),
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
    stateCode: p.enum(o, 'stateCode', STATE_CODES),
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
    stateCode: p.enum(o, 'stateCode', STATE_CODES),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    totalAssets: p.num(o, 'totalAssets', { min: 0 }),
    expectedPositionReturn: resolveGrowthRate(o, 'expectedPositionReturn', CONCENTRATION_HORIZON_YEARS),
    expectedMarketReturn: resolveMarketReturn(o, CONCENTRATION_HORIZON_YEARS),
    volatilityDrag: resolveDragFromVolatility(o, 'volatilityDrag', CONCENTRATION_HORIZON_YEARS),
  };
  // Mirror the drag's sigma source so hedge pricing uses the same value.
  const sigma = o.volatility !== undefined ? p.num(o, 'volatility', SIGMA_BOUNDS) : resolveSigmaFromTicker(o);
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

// THE single point of sigma resolution for protective_put_price. Returns the
// value AND its provenance as one object so the two cannot be set apart: any
// caller that takes the number takes the label with it, and a downstream
// re-derivation (the way an echo starts mislabeling a sector default as the
// stock's own vol) has nothing to re-derive from.
//
// WHY THIS ONE FALLS BACK AND THE DRAG-BEARING PARSERS THROW: `sector` is
// REQUIRED here, so an unresolved ticker still leaves a defensible, disclosed
// sector-typical IV, and hedge pricing degrades to "roughly what a name like
// this costs to hedge" rather than to nothing. The drag parsers have no such
// input and would have to invent one.
//
// DECIDED 2026-08-24 (operator), settling the deferral PR #240 recorded here:
// the response DOES disclose which source produced the sigma, via
// `volatilitySource` in the resolved-inputs echo. What tipped it: since the
// vols feed went live, a CDN blip silently turns a ticker-specific price into a
// sector-default one, and nothing in the response said so - the caller could
// not tell "we priced YOUR stock" from "we priced a stock like yours". The
// field deliberately does NOT separate outage from uncovered-symbol: both leave
// the caller holding a non-stock-specific price, which is the fact that changes
// what they should say, and the split would only invite agents to editorialize
// about our uptime (VOL_UNRESOLVED_REASON already owns that phrasing).
function resolveProtectivePutSigma(
  o: Obj,
  sectorDefault: number,
): { volatility: number; volatilitySource: VolatilitySource } {
  if (o.volatility !== undefined) {
    return { volatility: p.num(o, 'volatility', SIGMA_BOUNDS), volatilitySource: 'explicit' };
  }
  const fromTicker = resolveSigmaFromTicker(o);
  if (fromTicker !== null) return { volatility: fromTicker, volatilitySource: 'ticker' };
  return { volatility: sectorDefault, volatilitySource: 'sector-default' };
}

export function parseProtectivePutInput(raw: unknown): ProtectivePutInputs {
  const o = asObject(raw);
  const sector = p.enum(o, 'sector', SECTORS) as SectorKey;
  const sectorDefault = SECTOR_STATS[sector].annualVol * IV_OVER_RV_MULTIPLIER;
  const base: ProtectivePutInputs = {
    positionValue: p.num(o, 'positionValue', { min: 0 }),
    sector,
    ...resolveProtectivePutSigma(o, sectorDefault),
    protectionLevel: p.num(o, 'protectionLevel', { min: 0.05, max: 0.5 }),
    tenorYears: p.num(o, 'tenorYears', { min: 0.25 }),
  };
  if (o.expectedReturn !== undefined) base.expectedReturn = p.num(o, 'expectedReturn', RATE_BOUNDS);
  // Put-spread floor breach risk: target P(stock ends below the short strike).
  // Off-preset values snap to the nearest of SPREAD_RISK_LEVELS inside the calc,
  // so accept any probability in range and let the solve normalize it.
  if (o.spreadRiskLevel !== undefined) {
    base.spreadRiskLevel = p.num(o, 'spreadRiskLevel', { min: 0.01, max: 0.2 });
  }
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
  // Growth is required-or-resolved, like every other growth-bearing tool.
  // It used to be optional with a silent flat-price fallback — indistinguishable
  // from an explicit 0%/yr view, which quietly skewed `recommended` and
  // `holdForGrowth` toward selling early whenever an agent simply omitted the
  // field. A deliberately flat plan is still one token away: pass 0.
  stack.expectedAnnualGrowth = resolveGrowthRate(
    o,
    'expectedAnnualGrowth',
    horizonYears,
    `stacks[${index}].expectedAnnualGrowth`,
    true,
  );
  // Volatility is sidecar (returned next to the stack) because the calc
  // consumes it via the parallel `stackVolatilities` array, not via a
  // per-stack field. Caller assembles the array from this stream.
  const volatility = o.volatility !== undefined ? p.num(o, 'volatility', SIGMA_BOUNDS) : null;
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
    stateCode: p.enum(o, 'stateCode', STATE_CODES),
  };
  if (o.cashInterestRate !== undefined) base.cashInterestRate = p.num(o, 'cashInterestRate', CASH_RATE_BOUNDS);
  if (o.riskToleranceShortfall !== undefined) {
    base.riskToleranceShortfall = p.num(o, 'riskToleranceShortfall', { min: 0, max: 1 });
  }
  if (o.defaultVolatility !== undefined) base.defaultVolatility = p.num(o, 'defaultVolatility', SIGMA_BOUNDS);

  // Guard the two mutually exclusive shapes: passing both `stacks` and legacy
  // top-level `lots` silently dropped the lots (stacks won), losing part of the
  // position with no warning. Reject the ambiguous call instead.
  if (o.stacks !== undefined && o.lots !== undefined) {
    throw new Error('provide either "stacks" (v1.7+) or legacy "lots" + "currentPrice", not both.');
  }

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
  // Same required-or-resolved ladder as the stacks shape. The legacy schema
  // declares no top-level ticker, but the shared ladder resolves one if a
  // caller supplies it anyway — strictly more forgiving than erroring on a
  // stated symbol.
  base.expectedAnnualGrowth = resolveGrowthRate(o, 'expectedAnnualGrowth', horizonYears, 'expectedAnnualGrowth', true);
  return base;
}

/** Largest `lots` array rsu_lot_optimize accepts. Matches the web calculator's
 *  own cap, so a plan built in the browser can always be reproduced through the
 *  API. See the bound check in parseRsuLotOptimizeInput: this is a CPU budget,
 *  not tax law. */
export const MAX_RSU_LOT_ORDER_LOTS = 20;

function parseRsuLotOrderLot(raw: unknown, index: number, today: Date): LotDivestLot {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`lots[${index}] must be an object with vestDate, shares, costBasisPerShare`);
  }
  const o = raw as Obj;
  // Fractional shares are real (dividend-reinvest and net-settlement lots), so
  // this is p.num, not p.int — but a zero- or negative-share lot is meaningless.
  const shares = p.num(o, 'shares', { min: 0 });
  if (shares <= 0) throw new Error(`lots[${index}] field "shares" must be greater than 0`);
  const vestDate = p.date(o, 'vestDate');
  // This tool plans the sell-down of VESTED lots only (unvested grants are an
  // explicit non-goal). A future vestDate would otherwise be counted into the
  // divest total and sold as not-yet-owned shares. Compare by calendar day so a
  // lot vesting today is allowed. (Equity-funding accepts a future vestDate on
  // purpose, for unvested tranches; this tool deliberately does not.)
  if (dayUTC(vestDate) > dayUTC(today)) {
    throw new Error(
      `lots[${index}] field "vestDate" must be on or before today: this tool covers vested lots only, and unvested grants are out of scope.`,
    );
  }
  return {
    vestDate,
    shares,
    costBasisPerShare: p.num(o, 'costBasisPerShare', { min: 0 }),
  };
}

export function parseRsuLotOptimizeInput(raw: unknown, trustedToday?: Date): LotDivestInput {
  const o = asObject(raw);
  // `today` is NEVER taken from input: an LLM extractor with a stale training
  // cutoff could otherwise anchor every long-term-crossing date and sale year
  // in the past (the equity_funding_plan defect P13/RT1). Tests pass an
  // explicit trusted override; in production the server clock is authoritative.
  const today = trustedToday ?? new Date();
  const lotsRaw = o.lots;
  if (!Array.isArray(lotsRaw) || lotsRaw.length === 0) {
    throw new Error('field "lots" must be a non-empty array of {vestDate, shares, costBasisPerShare}');
  }
  // Upper bound is a CPU budget, not a tax rule, and it matches the web
  // calculator's cap so both surfaces accept the same inputs. The engine prices
  // lots against candidate sale dates on each of ~1,200 commit steps, for each
  // of the three horizon cards. Before the greedy's dominance pruning that cost
  // grew with the SQUARE of the lot count and a single call blew the Worker's
  // CPU limit past ~11 lots, returning an HTML 503 that broke the JSON error
  // contract every other failure here honours. Reject over-limit input with a
  // normal 400 instead, and say what to do about it.
  if (lotsRaw.length > MAX_RSU_LOT_ORDER_LOTS) {
    throw new Error(
      `field "lots" must contain at most ${MAX_RSU_LOT_ORDER_LOTS} lots (got ${lotsRaw.length}); ` +
        'combine lots that share a vest date and cost basis, or split the request',
    );
  }
  // horizonYears is the number of tax years the plan may span: 1 ("sell all
  // now"), 2, or 3. The engine's type is the literal union 1 | 2 | 3.
  const horizonYears = p.int(o, 'horizonYears', { min: 1, max: 3 }) as 1 | 2 | 3;
  return {
    lots: lotsRaw.map((lot, idx) => parseRsuLotOrderLot(lot, idx, today)),
    currentPrice: p.num(o, 'currentPrice', { min: 0 }),
    // Named `divestFraction` (a decimal, 0.10-1.0) rather than "percent" so an
    // agent that passes 50 meaning 50% is rejected by the max:1 bound instead
    // of silently divesting 5000%. Maps to the engine's `divestPercent` field.
    divestPercent: p.num(o, 'divestFraction', { min: 0.1, max: 1 }),
    horizonYears,
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
    stateCode: p.enum(o, 'stateCode', STATE_CODES),
    today,
  };
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
    stateCode: p.enum(o, 'stateCode', STATE_CODES),
    ordinaryIncome: p.num(o, 'ordinaryIncome', { min: 0 }),
    filingStatus: p.enum(o, 'filingStatus', FILING_STATUSES),
  };
}
