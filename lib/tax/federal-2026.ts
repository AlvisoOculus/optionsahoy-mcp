// AlphaLatitude Inc. © 2026
//
// Source: IRS Rev. Proc. 2025-32 (2026 inflation adjustments, incl. OBBBA),
// cross-checked against the IRS newsroom "tax inflation adjustments for tax
// year 2026" release. These are the IRS-PUBLISHED 2026 figures (not a CPI
// estimate); they match the year-keyed taxTables.js in the main app's
// IRS-validated tax engine. federal-2026.irs-conformance.test.ts asserts
// every value below against the published figures.
// Last reviewed: 2026-06-08.

import type { Bracket, Brackets } from './types';

// ---------------------------------------------------------------
// Ordinary income brackets (2026)
// ---------------------------------------------------------------

export const ORDINARY_2026: Brackets = {
  single: [
    { min: 0,       rate: 0.10 },
    { min: 12_400,  rate: 0.12 },
    { min: 50_400,  rate: 0.22 },
    { min: 105_700, rate: 0.24 },
    { min: 201_775, rate: 0.32 },
    { min: 256_225, rate: 0.35 },
    { min: 640_600, rate: 0.37 },
  ],
  married_joint: [
    { min: 0,       rate: 0.10 },
    { min: 24_800,  rate: 0.12 },
    { min: 100_800, rate: 0.22 },
    { min: 211_400, rate: 0.24 },
    { min: 403_550, rate: 0.32 },
    { min: 512_450, rate: 0.35 },
    { min: 768_700, rate: 0.37 },
  ],
  head_household: [
    { min: 0,       rate: 0.10 },
    { min: 17_700,  rate: 0.12 },
    { min: 67_450,  rate: 0.22 },
    { min: 105_700, rate: 0.24 },
    { min: 201_775, rate: 0.32 },
    { min: 256_200, rate: 0.35 },
    { min: 640_600, rate: 0.37 },
  ],
};

// ---------------------------------------------------------------
// Long-term capital gains brackets (2026)
// 0% / 15% / 20% based on (ordinary_income + ltcg) total
// ---------------------------------------------------------------

export const LTCG_2026: Brackets = {
  single: [
    { min: 0,       rate: 0.00 },
    { min: 49_450,  rate: 0.15 },
    { min: 545_500, rate: 0.20 },
  ],
  married_joint: [
    { min: 0,       rate: 0.00 },
    { min: 98_900,  rate: 0.15 },
    { min: 613_700, rate: 0.20 },
  ],
  head_household: [
    { min: 0,       rate: 0.00 },
    { min: 66_200,  rate: 0.15 },
    { min: 579_600, rate: 0.20 },
  ],
};

// ---------------------------------------------------------------
// Standard deduction (2026)
// ---------------------------------------------------------------

export const STANDARD_DEDUCTION_2026: Record<keyof typeof ORDINARY_2026, number> = {
  single: 16_100,
  married_joint: 32_200,
  head_household: 24_150,
};

// ---------------------------------------------------------------
// Net Investment Income Tax (NIIT)
// 3.8% on the lesser of (investment income) or (AGI − threshold).
// Thresholds are statutory and DO NOT inflate.
// ---------------------------------------------------------------

export const NIIT_RATE = 0.038;

export const NIIT_THRESHOLDS: Record<keyof typeof ORDINARY_2026, number> = {
  single: 200_000,
  married_joint: 250_000,
  head_household: 200_000,
};

// ---------------------------------------------------------------
// Risk-free rate (1Y Treasury, used for Black-Scholes hedging cost).
// Refresh semi-annually.
// ---------------------------------------------------------------

export const RISK_FREE_RATE_1Y = 0.045;

// Re-export Bracket for convenience
export type { Bracket };
