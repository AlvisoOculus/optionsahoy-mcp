// AlphaLatitude Inc. © 2026
//
// FICA (Federal Insurance Contributions Act) and Additional Medicare Tax
// constants for tax year 2026.
//
// SOURCES:
//   - SS wage base: SSA Fact Sheet, "2026 Social Security Changes"
//     https://www.ssa.gov/oact/cola/cbb.html
//     Refresh each October when SSA announces the next year's wage base.
//   - SS + Medicare rates: IRC § 3101(a) (employee SS = 6.2%) and § 3101(b)(1)
//     (employee Medicare = 1.45%). These are statutory and have not changed
//     since the Affordable Care Act took effect in 2013 (Medicare rate) and
//     1990 (SS rate).
//   - Additional Medicare Tax: IRC § 3101(b)(2). Statutory thresholds — they
//     do NOT inflate annually unlike the wage base.
//
// HoH threshold parity: § 1411 / § 3101(b)(2) use the same threshold for
// Single and Head of Household ($200,000). This is the unique-to-FICA case
// where HoH does NOT track Single — but in practice they're equal at this
// threshold so it's a non-issue for the calculator.
//
// Last reviewed: 2026-04-30.

import type { FilingStatus } from './types';

// 2026 SS wage base (employee + employer each pay 6.2% on wages up to this).
// SSA announces each October for the following year. Update annually.
// 2024: $168,600 → 2025: $176,100 (+4.4%) → projected 2026: ~$184,500.
export const SS_WAGE_BASE_2026 = 184_500;

export const SS_RATE_EMPLOYEE = 0.062;
export const MEDICARE_RATE = 0.0145;
export const ADD_MEDICARE_RATE = 0.009;

// Additional Medicare Tax thresholds (IRC § 3101(b)(2), statutory).
export const ADD_MEDICARE_THRESHOLD: Record<FilingStatus, number> = {
  single: 200_000,
  married_joint: 250_000,
  head_household: 200_000,
};

/**
 * Employee Social Security tax on incremental wages added on top of
 * `existingWages`. SS caps at SS_WAGE_BASE_2026; once existing wages exceed
 * the base, no further SS tax is owed.
 */
export function socialSecurityTaxOnAddedWages(
  existingWages: number,
  addedWages: number,
): number {
  if (addedWages <= 0) return 0;
  const remainingBase = Math.max(0, SS_WAGE_BASE_2026 - Math.max(0, existingWages));
  const taxable = Math.min(addedWages, remainingBase);
  return taxable * SS_RATE_EMPLOYEE;
}

/**
 * Employee Medicare tax on incremental wages. Flat 1.45%, no cap.
 */
export function medicareTaxOnAddedWages(addedWages: number): number {
  if (addedWages <= 0) return 0;
  return addedWages * MEDICARE_RATE;
}

/**
 * Additional Medicare tax (0.9%) on the portion of total wages above the
 * filing-status threshold that comes from the added wages. Computed as the
 * marginal delta: (tax on existing + added) − (tax on existing).
 */
export function additionalMedicareTaxOnAddedWages(
  existingWages: number,
  addedWages: number,
  filingStatus: FilingStatus,
): number {
  if (addedWages <= 0) return 0;
  const threshold = ADD_MEDICARE_THRESHOLD[filingStatus];
  const totalAfter = Math.max(0, existingWages) + addedWages;
  const baseAfter = Math.max(0, totalAfter - threshold);
  const baseBefore = Math.max(0, Math.max(0, existingWages) - threshold);
  return (baseAfter - baseBefore) * ADD_MEDICARE_RATE;
}
