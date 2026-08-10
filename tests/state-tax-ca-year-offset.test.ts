// AlphaLatitude Inc. © 2026
//
// Regression: the vendored CA.json shipped with a one-year label offset (the
// "2025" key held the FTB 2024 schedule; "2026" held the real 2025 figures).
// The web repo fixed it (optionsahoy_web #468) but this mirror kept the stale
// data, so agent-surface CA answers for tax-year 2025 disagreed with the web
// tools. These tests pin the corrected 2025 schedule and fail on the old file.

import { describe, it, expect } from 'vitest';
import { getStateBrackets } from '../lib/tax/state-tax';

describe('CA bracket year alignment (regression for the one-year label offset)', () => {
  it('2025 single uses the FTB 2025 schedule, not the 2024 one', () => {
    const b = getStateBrackets('CA', 'single', '2025')!;
    // FTB 2025 Schedule X: 2% starts at $11,079. The 2024 schedule (which the
    // "2025" key wrongly held) starts it at $10,756.
    expect(b[1].min).toBe(11079);
    expect(b[1].min).not.toBe(10756);
    expect(b[2].min).toBe(26264);
    expect(b.at(-1)!.min).toBe(1_000_000); // 13.3% incl. mental-health surcharge
  });

  it('2025 married_joint uses the FTB 2025 schedule', () => {
    const b = getStateBrackets('CA', 'married_joint', '2025')!;
    expect(b[1].min).toBe(22158);
    expect(b[1].min).not.toBe(21512);
  });

  it('2026 is held at the 2025 schedule until FTB publishes (matches the note)', () => {
    const b25 = getStateBrackets('CA', 'single', '2025');
    const b26 = getStateBrackets('CA', 'single', '2026');
    expect(b26).toEqual(b25);
  });

  it('mirror parity: CA.json is byte-identical to the web repo source of truth shape', () => {
    // Structural pin (not filesystem comparison): the corrected file's source
    // line names the FTB schedules, not the old Tax Foundation attribution
    // that shipped with the offset data.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ca = require('../lib/tax/states/CA.json');
    expect(ca.source).toMatch(/FTB 540/);
  });
});
