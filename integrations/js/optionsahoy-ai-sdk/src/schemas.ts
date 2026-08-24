// AlphaLatitude Inc. © 2026
//
// Zod input schemas, one per OptionsAhoy calculator endpoint. Required vs
// optional fields mirror the published OpenAPI request bodies (see
// https://optionsahoy.com/openapi.json). Growth- and volatility-bearing tools
// (ISO, NSO, RSU, concentration, protective put) accept an optional `ticker`
// that lets the API derive forward-looking inputs from a covered symbol.

import { z } from 'zod';

// --- shared enums (sourced from the OpenAPI spec) --------------------------

export const filingStatus = z
  .enum(['single', 'married_joint', 'head_household'])
  .describe('Federal filing status.');

/** The 50 US states plus DC that the tax engine models. */
export const stateCode = z
  .enum([
    'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI',
    'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN',
    'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH',
    'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA',
    'WI', 'WV', 'WY',
  ])
  .describe('Two-letter US state code (or DC).');

export const sector = z
  .enum([
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
  ])
  .describe('Sector tag. Sets the default volatility used for hedge pricing.');

const ticker = z
  .string()
  .describe(
    'Optional covered public-stock symbol (e.g. "NVDA", "AAPL"). When set, the API substitutes a cached trailing return for any unsupplied expected-return / sale-price field, and the implied volatility as of the last close for any unsupplied volatility.',
  );

const isoDate = (what: string) => z.string().describe(`${what} ISO-8601 date (YYYY-MM-DD).`);

// --- amt_iso_optimize ------------------------------------------------------

export const amtIsoParameters = z.object({
  shares: z.number().int().min(1).describe('ISO shares available to exercise across the horizon.'),
  strike: z.number().min(0).describe('Exercise (strike) price per share, USD.'),
  fmv: z.number().min(0).describe('Current fair market value per share, USD.'),
  filingStatus,
  ordinaryIncome: z.number().min(0).describe('Annual ordinary income before this exercise, USD.'),
  stateCode,
  carryforwardCredit: z.number().min(0).describe('Existing federal AMT credit carryforward, USD.'),
  horizon: z.number().int().min(1).max(10).describe('Planning horizon in years (1 to 10).'),
  cashReturnRate: z
    .number()
    .optional()
    .describe('Annual after-tax return on idle cash, decimal (0.05 = 5%). Defaults to 0.04 server-side when omitted.'),
  grantDate: isoDate('ISO grant date.'),
  hasLeftCompany: z.boolean().describe('True if the holder has separated from the company.'),
  terminationDate: z
    .string()
    .nullable()
    .optional()
    .describe('Separation date (YYYY-MM-DD); required only when hasLeftCompany is true, else null.'),
  expectedGrowth: z.number().optional().describe('Expected annual share-price growth, decimal.'),
  volatility: z.number().min(0).optional().describe('Annualized volatility (sigma), decimal.'),
  volatilityDrag: z.number().min(0).max(0.99).optional().describe('Horizon price haircut, 0 to 0.99.'),
  ticker: ticker.optional(),
});

// --- nso_calculate ---------------------------------------------------------

export const nsoParameters = z.object({
  shares: z.number().int().min(1).describe('NSO shares to exercise.'),
  strike: z.number().min(0).describe('Exercise (strike) price per share, USD.'),
  currentPrice: z.number().min(0).describe('Current share price, USD.'),
  ordinaryIncome: z.number().min(0).describe('Annual ordinary income before this exercise, USD.'),
  filingStatus,
  stateCode,
  stillEmployed: z.boolean().describe('True if still employed at exercise (FICA applies when true).'),
  holdYears: z.number().min(1).describe('Years held after exercise (at least 1).'),
  holdFunding: z
    .enum(['sell-to-cover', 'cash'])
    .describe('How the strike cost and exercise tax are funded.'),
  expectedSalePrice: z.number().min(0).optional().describe('Projected $/share at end of holdYears.'),
  volatility: z.number().min(0).optional().describe('Annualized volatility (sigma), decimal.'),
  expectedMarketReturn: z.number().optional().describe('Reinvestment rate for the sell-now path, decimal.'),
  haircut: z.number().min(0).max(1).optional().describe('Risk haircut on expected upside.'),
  ticker: ticker.optional(),
});

// --- rsu_sell_vs_hold ------------------------------------------------------

export const rsuParameters = z.object({
  shares: z.number().int().min(1).describe('Vested RSU shares in this tranche.'),
  currentPrice: z.number().min(0).describe('Fair market value per share at vest, USD.'),
  ordinaryIncome: z.number().min(0).describe('Annual ordinary income before this vest, USD.'),
  filingStatus,
  stateCode,
  stillEmployed: z.boolean().describe('True if still employed at vest.'),
  holdYears: z.number().min(0.25).max(5).describe('Years held after vest (0.25 to 5).'),
  expectedSalePrice: z.number().min(0).optional().describe('Projected $/share at end of holdYears.'),
  volatility: z.number().min(0).optional().describe('Annualized volatility (sigma), decimal.'),
  expectedMarketReturn: z.number().optional().describe('Reinvestment rate for the sell-now path, decimal.'),
  haircut: z.number().min(0).max(1).optional().describe('Risk haircut on expected upside.'),
  ticker: ticker.optional(),
});

// --- concentration_analyze -------------------------------------------------

const hedgeChoice = z
  .object({
    kind: z.enum(['put', 'collar']).describe('Hedge instrument to price.'),
    protectionLevel: z.number().min(0.05).max(0.5).describe('Put strike as (1 - this) x spot, 0.05 to 0.5.'),
    tenorYears: z.number().min(0.25).describe('Option tenor in years.'),
    upsideCapPct: z.number().optional().describe('Collar upside cap as a fraction above spot; omit for zero-cost.'),
  })
  .describe('Optional hedge to price in the hedging block instead of the default 1-year 30%-OTM put.');

export const concentrationParameters = z.object({
  positionValue: z.number().min(0).describe('Current market value of the concentrated position, USD.'),
  costBasis: z.number().min(0).describe('Total cost basis of the position, USD.'),
  acquisitionDate: isoDate('Earliest acquisition date in the lot.'),
  sector,
  stateCode,
  filingStatus,
  ordinaryIncome: z.number().min(0).describe('Annual ordinary income before any sales, USD.'),
  totalAssets: z
    .number()
    .min(0)
    .describe('Total investable portfolio including this position, USD. Must come from the user; never inferred.'),
  expectedPositionReturn: z.number().optional().describe('Expected annual return on the stock, decimal.'),
  expectedMarketReturn: z.number().optional().describe('Reinvestment rate, decimal.'),
  volatility: z.number().min(0).optional().describe('Annualized volatility (sigma), decimal.'),
  volatilityDrag: z.number().min(0).max(0.99).optional().describe('Horizon price haircut, 0 to 0.99.'),
  ticker: ticker.optional(),
  hedgeChoice: hedgeChoice.optional(),
});

// --- protective_put_price --------------------------------------------------

export const protectivePutParameters = z.object({
  positionValue: z.number().min(0).describe('Market value of the position to hedge, USD.'),
  sector,
  protectionLevel: z.number().min(0.05).max(0.5).describe('Downside protected as a fraction, 0.05 to 0.5.'),
  tenorYears: z.number().min(0.25).describe('Hedge tenor in years (at least 0.25).'),
  volatility: z.number().min(0).optional().describe('Annualized implied volatility (sigma), decimal.'),
  expectedReturn: z.number().optional().describe('Annual expected return for the probability metrics, decimal.'),
  ticker: ticker.optional(),
  tickerLabel: z.string().optional().describe('Optional display label echoed back in the result.'),
  spreadRiskLevel: z
    .number()
    .min(0.01)
    .max(0.2)
    .optional()
    .describe('Put-spread floor breach risk (presets 0.20 / 0.10 / 0.05 / 0.01). Affects only putSpread. Default 0.10.'),
});

// --- qsbs_check ------------------------------------------------------------

export const qsbsParameters = z.object({
  acquisitionDate: isoDate('Date the QSBS shares were acquired.'),
  saleDate: isoDate('Planned or actual sale date.'),
  entityType: z.enum(['us-c-corp', 'other']).describe('Issuer entity type at acquisition. Only us-c-corp can qualify.'),
  acquisitionMethod: z
    .enum(['original-issuance', 'gift-or-inheritance', 'secondary', 'unsure'])
    .describe('How the shares were obtained.'),
  assetCategory: z
    .enum(['under-50m', '50m-to-75m', 'over-75m', 'unsure'])
    .describe('Issuer gross assets at issuance.'),
  industry: z
    .enum([
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
    ])
    .describe('Dominant industry of the issuing corporation.'),
  activeBusiness: z.enum(['yes', 'no', 'unsure']).describe('Whether the issuer meets the 80% active-business test.'),
  adjustedBasis: z.number().min(0).describe('Adjusted basis in the shares, USD.'),
  expectedGain: z.number().describe('Expected total gain on sale, USD.'),
  stateCode,
  ordinaryIncome: z.number().min(0).describe('Annual ordinary income, USD.'),
  filingStatus,
});

// --- equity_funding_plan ---------------------------------------------------

const fundingLot = z.object({
  shares: z.number().int().min(1).describe('Whole shares in this lot.'),
  costBasisPerShare: z.number().min(0).describe('Per-share cost basis, USD.'),
  acquisitionDate: isoDate('Acquisition date; sets the long-term-vs-short-term threshold.'),
  vestDate: z.string().optional().describe('Optional future vest date for an unvested RSU tranche (YYYY-MM-DD).'),
});

const fundingStack = z.object({
  currentPrice: z.number().min(0).describe('$/share today for this stack.'),
  lots: z.array(fundingLot).min(1).describe('Cost-basis cohorts within this stack.'),
  ticker: z.string().optional().describe('Optional ticker; resolves expectedAnnualGrowth when omitted.'),
  expectedAnnualGrowth: z.number().optional().describe('Per-stack annual growth decimal. Defaults to 0.'),
  volatility: z.number().min(0).optional().describe('Per-stack annualized sigma for the shortfall model.'),
});

export const equityFundingParameters = z.object({
  targetAfterTax: z.number().min(0).describe('Net after-tax cash goal to raise, USD.'),
  targetDate: isoDate('Date the cash is needed.'),
  ordinaryIncome: z.number().min(0).describe('Annual ordinary income, USD.'),
  filingStatus,
  stateCode,
  stacks: z
    .array(fundingStack)
    .min(1)
    .optional()
    .describe('Preferred multi-stack holdings. Provide either stacks OR the legacy lots + currentPrice pair.'),
  lots: z.array(fundingLot).min(1).optional().describe('Legacy single-stack lots (pair with currentPrice).'),
  currentPrice: z.number().min(0).optional().describe('Legacy single-stack current share price, USD.'),
  expectedAnnualGrowth: z.number().optional().describe('Legacy single-stack annual growth decimal.'),
  cashInterestRate: z.number().optional().describe('Annual pre-tax yield on idle cash, decimal. Default 0.'),
  riskToleranceShortfall: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Max acceptable probability of missing the goal, 0 to 1. Default 0.10.'),
  defaultVolatility: z.number().min(0).optional().describe('Annualized sigma for stacks without their own. Default 0.30.'),
});

// --- rsu_lot_optimize ------------------------------------------------------

const rsuLot = z.object({
  vestDate: isoDate('Vest date for this lot; sets the long-term-vs-short-term threshold.'),
  shares: z.number().describe('Vested shares in this lot.'),
  costBasisPerShare: z.number().min(0).describe('Per-share cost basis (fair market value at vest), USD.'),
});

export const rsuLotParameters = z.object({
  lots: z.array(rsuLot).min(1).describe('Vested RSU lots to consider selling.'),
  currentPrice: z.number().min(0).describe('Current share price, USD.'),
  divestFraction: z.number().min(0.1).max(1.0).describe('Target fraction of shares to divest, 0.1 to 1.0.'),
  horizonYears: z.number().int().min(1).max(3).describe('Planning horizon in years (1 to 3).'),
  ordinaryIncome: z.number().min(0).describe('Annual ordinary income before any sales, USD.'),
  filingStatus,
  stateCode,
});
