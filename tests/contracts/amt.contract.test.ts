// AlphaLatitude Inc. © 2026
//
// Runs the AMT/ISO answer contract (amt.contract.ts) plus a direct formatter
// check for the negative lump-sum NFV edge (P12). Fails red on the pre-fix
// formatter: a closed exercise window was ignored (P4) and carryforward AMT
// credit was hidden when none was recovered in-plan (P5).

import { describe, it, expect } from 'vitest';
import { headline } from '../../functions/poe';
import { amtContract } from './amt.contract';
import { registerContractTests } from './run-contract';

registerContractTests(amtContract);

// P12: lumpSum.nfv can be negative (engine returns -amtPremiumFV when a single
// all-at-once exercise costs more than it nets). The comparison line must read
// as a loss, not the awkward "far more than ... (-$21,754)".
describe('amt_iso_optimize contract — P12: negative lump-sum NFV phrasing', () => {
  const result = {
    schedules: {
      optimized: { nfv: 100000, years: [{ year: 1, shares: 1000 }], exerciseTax: 0, creditRecovered: 0, creditRemaining: 0 },
      evenSplit: { nfv: 50000 },
      lumpSum: { nfv: -21754 },
    },
    timing: { windowClosed: false, daysUntilWindowClose: null, qdNotYetEligible: false },
  };
  const text = headline('amt_iso_optimize', result as any);

  it('phrases a negative lump-sum as a loss', () => {
    expect(text).toMatch(/exercising everything at once would actually net a loss of about \$21,754/);
  });
  it('never renders the awkward "(-$...)" form', () => {
    expect(text).not.toMatch(/\(-\$/);
  });
});
