// AlphaLatitude Inc. © 2026
//
// Federal tax constants for the current tax year.
//
// These are NO LONGER hand-edited. They are derived from the single source of
// record: the main app's year-keyed taxTables.js (cross-checked against the IRS
// publications), mirrored into generated/federal-tax-tables.generated.ts by
// scripts/codegen/gen-federal-tax-tables.mjs. The IRS-conformance test asserts
// the resolved values equal the published 2026 figures, so any drift in the
// source or the codegen fails the build.
//
// The `_2026` export names are retained for existing consumers; they resolve to
// the current tax year (DEFAULT_TAX_YEAR in the generated source).
import type { Bracket, Brackets, FilingStatus } from './types';
import { CURRENT_FEDERAL_TABLE } from './generated/federal-tax-tables.generated';

export const ORDINARY_2026: Brackets = CURRENT_FEDERAL_TABLE.ordinary;

export const LTCG_2026: Brackets = CURRENT_FEDERAL_TABLE.ltcg;

export const STANDARD_DEDUCTION_2026: Record<FilingStatus, number> =
  CURRENT_FEDERAL_TABLE.stdDeduction;

// Net Investment Income Tax (IRC § 1411): 3.8% over the statutory MAGI threshold.
export const NIIT_RATE = CURRENT_FEDERAL_TABLE.niit.rate;

export const NIIT_THRESHOLDS: Record<FilingStatus, number> = CURRENT_FEDERAL_TABLE.niit.threshold;

// 1-year risk-free rate (Treasury yield) for the Black-Scholes hedging cost.
// NOT a tax constant and not sourced from the IRS tables; hand-maintained,
// refresh semi-annually.
export const RISK_FREE_RATE_1Y = 0.045;

// Re-export Bracket for convenience
export type { Bracket };
