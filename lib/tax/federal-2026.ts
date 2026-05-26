// AlphaLatitude Inc. © 2026
//
// Source: IRS Rev. Proc. 2025-32 (announces 2026 inflation adjustments).
// Verify against the official text before relying on these for tax filing.
// These values are derived from 2025 actuals (Rev. Proc. 2024-40) with the
// standard CPI-driven inflation adjustment (~2.7%); a planning calculator
// is not affected by the dollar-level rounding the IRS applies.
// Last reviewed: 2026-04-25.

import type { Bracket, Brackets } from './types';

// ---------------------------------------------------------------
// Ordinary income brackets (2026)
// ---------------------------------------------------------------

export const ORDINARY_2026: Brackets = {
  single: [
    { min: 0,       rate: 0.10 },
    { min: 12_250,  rate: 0.12 },
    { min: 49_800,  rate: 0.22 },
    { min: 106_150, rate: 0.24 },
    { min: 202_700, rate: 0.32 },
    { min: 257_300, rate: 0.35 },
    { min: 643_400, rate: 0.37 },
  ],
  married_joint: [
    { min: 0,       rate: 0.10 },
    { min: 24_500,  rate: 0.12 },
    { min: 99_600,  rate: 0.22 },
    { min: 212_300, rate: 0.24 },
    { min: 405_300, rate: 0.32 },
    { min: 514_600, rate: 0.35 },
    { min: 772_300, rate: 0.37 },
  ],
  head_household: [
    { min: 0,       rate: 0.10 },
    { min: 17_450,  rate: 0.12 },
    { min: 66_600,  rate: 0.22 },
    { min: 106_150, rate: 0.24 },
    { min: 202_700, rate: 0.32 },
    { min: 257_300, rate: 0.35 },
    { min: 643_400, rate: 0.37 },
  ],
};

// ---------------------------------------------------------------
// Long-term capital gains brackets (2026)
// 0% / 15% / 20% based on (ordinary_income + ltcg) total
// ---------------------------------------------------------------

export const LTCG_2026: Brackets = {
  single: [
    { min: 0,       rate: 0.00 },
    { min: 49_650,  rate: 0.15 },
    { min: 547_800, rate: 0.20 },
  ],
  married_joint: [
    { min: 0,       rate: 0.00 },
    { min: 99_300,  rate: 0.15 },
    { min: 616_250, rate: 0.20 },
  ],
  head_household: [
    { min: 0,       rate: 0.00 },
    { min: 66_500,  rate: 0.15 },
    { min: 581_950, rate: 0.20 },
  ],
};

// ---------------------------------------------------------------
// Standard deduction (2026)
// ---------------------------------------------------------------

export const STANDARD_DEDUCTION_2026: Record<keyof typeof ORDINARY_2026, number> = {
  single: 15_400,
  married_joint: 30_800,
  head_household: 23_100,
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
