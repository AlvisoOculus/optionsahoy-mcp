// AlphaLatitude Inc. © 2026
//
// Federal Alternative Minimum Tax constants for tax year 2026.
//
// SOURCE: IRS Rev. Proc. 2025-32 §3.10 — "Exemption Amounts for Alternative
// Minimum Tax". https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
//
// REFRESH (each January): the IRS publishes Rev. Proc. 20YY-XX (where YY is
// the current calendar year) covering the *next* tax year's inflation
// adjustments. Find §3.10 — three tables (exemption / 28% breakpoint /
// phaseout). Update the four constants below verbatim. Bump the year in the
// file name and re-export.
//
// PHASEOUT RATE: post-OBBBA (One Big Beautiful Bill Act §70107, amending
// IRC § 55(d)(4) effective 2026), the exemption phases out at 50¢ per $1
// of AMTI above the threshold — not the historical 25¢. Verify by
// arithmetic: complete_phaseout − threshold should equal 2 × exemption in
// every filing category. If a future Rev. Proc. table no longer satisfies
// that identity, the rate has changed and AMT_PHASEOUT_RATE must update.
//
// HOH: § 55(d)(1) does not separately enumerate Head of Household; HoH uses
// the same exemption and phaseout threshold as Unmarried Individuals.
//
// Last reviewed: 2026-04-29.

import type { FilingStatus } from './types';

// AMT supports only the 3 statuses our calculator exposes (federal § 55(d)(1)
// also defines MFS but the calculator UI omits it per the concentration tool's
// precedent).
export type AmtFilingStatus = FilingStatus;

export const AMT_EXEMPTION_2026: Record<AmtFilingStatus, number> = {
  single:         90_100,
  married_joint:  140_200,
  head_household: 90_100,
};

export const AMT_PHASEOUT_START_2026: Record<AmtFilingStatus, number> = {
  single:         500_000,
  married_joint:  1_000_000,
  head_household: 500_000,
};

export const AMT_PHASEOUT_RATE = 0.50;

export const AMT_BREAKPOINT_2026 = 244_500;

export const AMT_RATES = {
  lower: 0.26,
  upper: 0.28,
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
