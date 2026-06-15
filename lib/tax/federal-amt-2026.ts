// AlphaLatitude Inc. © 2026
//
// Federal Alternative Minimum Tax constants for the current tax year.
//
// These constants are NO LONGER hand-edited. They are derived from the single
// source of record (the main app's year-keyed taxTables.js, cross-checked
// against IRS Rev. Proc. 2025-32 §3.10), mirrored into
// generated/federal-tax-tables.generated.ts. The IRS-conformance test asserts
// the resolved values equal the published 2026 figures.
//
// PHASEOUT RATE: post-OBBBA (One Big Beautiful Bill Act §70107, amending
// IRC § 55(d)(4) effective 2026), the exemption phases out at 50¢ per $1 of
// AMTI above the threshold, not the historical 25¢. HoH uses the same exemption
// and phaseout threshold as Unmarried Individuals (§ 55(d)(1)).
import type { FilingStatus } from './types';
import { CURRENT_FEDERAL_TABLE } from './generated/federal-tax-tables.generated';

// AMT supports only the 3 statuses our calculator exposes (federal § 55(d)(1)
// also defines MFS but the calculator UI omits it per the concentration tool's
// precedent).
export type AmtFilingStatus = FilingStatus;

const AMT = CURRENT_FEDERAL_TABLE.amt;

export const AMT_EXEMPTION_2026: Record<AmtFilingStatus, number> = AMT.exemption;

export const AMT_PHASEOUT_START_2026: Record<AmtFilingStatus, number> = AMT.phaseoutStart;

export const AMT_PHASEOUT_RATE = AMT.phaseoutRate;

export const AMT_BREAKPOINT_2026 = AMT.breakpoint;

export const AMT_RATES = {
  lower: AMT.rateLower,
  upper: AMT.rateUpper,
} as const;

/**
 * AMT exemption after phaseout. § 55(d)(2) reduces the full exemption by
 * AMT_PHASEOUT_RATE × max(0, amti − threshold), floored at 0.
 */
export function amtExemption(amti: number, status: AmtFilingStatus): number {
  const full = AMT_EXEMPTION_2026[status];
  const start = AMT_PHASEOUT_START_2026[status];
  const phasedOut = Math.max(0, amti - start) * AMT_PHASEOUT_RATE;
  return Math.max(0, full - phasedOut);
}

/**
 * Tentative Minimum Tax (TMT) for a given AMTI and filing status.
 * § 55(b)(1): 26% on the first AMT_BREAKPOINT_2026 of taxable excess (AMTI −
 * exemption), 28% on the rest. Floored at 0.
 */
export function tentativeMinimumTax(amti: number, status: AmtFilingStatus): number {
  const exemption = amtExemption(amti, status);
  const taxableExcess = Math.max(0, amti - exemption);
  if (taxableExcess <= AMT_BREAKPOINT_2026) {
    return taxableExcess * AMT_RATES.lower;
  }
  return (
    AMT_BREAKPOINT_2026 * AMT_RATES.lower +
    (taxableExcess - AMT_BREAKPOINT_2026) * AMT_RATES.upper
  );
}
