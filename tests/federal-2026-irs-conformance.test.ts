// AlphaLatitude Inc. © 2026
//
// IRS-publication conformance tripwire for the 2026 federal constants used by
// the MCP server + REST API. Asserts every 2026 value is IDENTICAL to the
// IRS-published figure (Rev. Proc. 2025-32 incl. OBBBA), not a CPI estimate.
//
// This mirrors the same tripwire in the web repo and the year-2026 entry of
// the main app's IRS-validated taxTables.js, so the three engines can't
// silently diverge from the IRS — or each other.
//
// SOURCES: Rev. Proc. 2025-32 + IRS newsroom "tax inflation adjustments for
// tax year 2026 including amendments from the One, Big, Beautiful Bill";
// AMT 26/28 breakpoint from Form 6251 instructions; AMT phaseout rate 50% per
// IRC §55(d)(4) (OBBBA); NIIT 3.8% + thresholds per IRC §1411; SS wage base
// $184,500 per SSA 2026; Medicare/Additional Medicare per IRC §3101(b).

import { describe, expect, it } from 'vitest';
import {
  ORDINARY_2026,
  LTCG_2026,
  STANDARD_DEDUCTION_2026,
  NIIT_RATE,
  NIIT_THRESHOLDS,
} from '../lib/tax/federal-2026';
import {
  AMT_EXEMPTION_2026,
  AMT_PHASEOUT_START_2026,
  AMT_PHASEOUT_RATE,
  AMT_BREAKPOINT_2026,
  AMT_RATES,
} from '../lib/tax/federal-amt-2026';
import {
  SS_WAGE_BASE_2026,
  SS_RATE_EMPLOYEE,
  MEDICARE_RATE,
  ADD_MEDICARE_RATE,
  ADD_MEDICARE_THRESHOLD,
} from '../lib/tax/fica-2026';

const mins = (s: keyof typeof ORDINARY_2026) => ORDINARY_2026[s].map((b) => b.min);
const ltcgMins = (s: keyof typeof LTCG_2026) => LTCG_2026[s].map((b) => b.min);

describe('2026 ordinary brackets === IRS Rev. Proc. 2025-32', () => {
  it('single', () => {
    expect(mins('single')).toEqual([0, 12_400, 50_400, 105_700, 201_775, 256_225, 640_600]);
    expect(ORDINARY_2026.single.map((b) => b.rate)).toEqual([0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37]);
  });
  it('married filing jointly', () => {
    expect(mins('married_joint')).toEqual([0, 24_800, 100_800, 211_400, 403_550, 512_450, 768_700]);
  });
  it('head of household', () => {
    expect(mins('head_household')).toEqual([0, 17_700, 67_450, 105_700, 201_775, 256_200, 640_600]);
  });
});

describe('2026 LTCG breakpoints === IRS published', () => {
  it('single / MFJ / HoH', () => {
    expect(ltcgMins('single')).toEqual([0, 49_450, 545_500]);
    expect(ltcgMins('married_joint')).toEqual([0, 98_900, 613_700]);
    expect(ltcgMins('head_household')).toEqual([0, 66_200, 579_600]);
  });
});

describe('2026 standard deduction === IRS published', () => {
  it('single / MFJ / HoH', () => {
    expect(STANDARD_DEDUCTION_2026.single).toBe(16_100);
    expect(STANDARD_DEDUCTION_2026.married_joint).toBe(32_200);
    expect(STANDARD_DEDUCTION_2026.head_household).toBe(24_150);
  });
});

describe('2026 AMT === IRS Rev. Proc. 2025-32 + OBBBA', () => {
  it('exemption / phaseout start / rate / breakpoint', () => {
    expect(AMT_EXEMPTION_2026.single).toBe(90_100);
    expect(AMT_EXEMPTION_2026.married_joint).toBe(140_200);
    expect(AMT_PHASEOUT_START_2026.single).toBe(500_000);
    expect(AMT_PHASEOUT_START_2026.married_joint).toBe(1_000_000);
    expect(AMT_PHASEOUT_RATE).toBe(0.50);
    expect(AMT_BREAKPOINT_2026).toBe(244_500);
    expect(AMT_RATES.lower).toBe(0.26);
    expect(AMT_RATES.upper).toBe(0.28);
  });
});

describe('NIIT (§1411) + FICA (SSA / §3101)', () => {
  it('NIIT 3.8% over $200k/$250k', () => {
    expect(NIIT_RATE).toBe(0.038);
    expect(NIIT_THRESHOLDS.single).toBe(200_000);
    expect(NIIT_THRESHOLDS.married_joint).toBe(250_000);
  });
  it('FICA wage base $184,500; Medicare 1.45%; Additional Medicare 0.9% over $200k/$250k', () => {
    expect(SS_WAGE_BASE_2026).toBe(184_500);
    expect(SS_RATE_EMPLOYEE).toBe(0.062);
    expect(MEDICARE_RATE).toBe(0.0145);
    expect(ADD_MEDICARE_RATE).toBe(0.009);
    expect(ADD_MEDICARE_THRESHOLD.single).toBe(200_000);
    expect(ADD_MEDICARE_THRESHOLD.married_joint).toBe(250_000);
  });
});
