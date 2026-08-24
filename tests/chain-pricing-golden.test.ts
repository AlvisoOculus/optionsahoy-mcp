// AlphaLatitude Inc. © 2026
//
// GOLDEN EQUIVALENCE for chain-based hedge pricing: the strike-level
// implied-volatility interpolation (lib/data/chainPricing.ts) AND the adapter
// that turns a chain into engine inputs (lib/data/chain-hedge-inputs.ts).
//
// Both are ports: the production chain-driven calculator in the sibling repo
// has priced protective puts this way for months, and MCP now prices them the
// same way. A port is only worth having if it is provably the same port, so the
// numbers below are not "what our functions return today" - they were produced
// by running the SIBLING repo's implementation over the committed fixture and
// pasting its output.
//
// PROVENANCE of every expected value in this file:
//   source file : optionsahoy_web/web/lib/data/chainPricing.ts
//   at commit   : eb8973fd ("Vols follow-ups: openapi mirror (mcp #241) +
//                 watchdog check 9 on the artifact (#843)")
//   run on      : tests/fixtures/chain-nvda-v3.json (a real NVDA chain,
//                 captured 2026-08-24 from data.optionsahoy.com/chains/fetch)
//   with        : today = 2026-08-24T00:00:00Z, side 'P' unless noted
//   how         : the file was bundled out of the read-only sibling checkout
//                 with esbuild (alias @/lib -> that repo's web/lib) and run on
//                 the fixture. Nothing imports across repos, at test time or
//                 at build time; these are literals.
//
// At the time of writing the two files are also BYTE-IDENTICAL, which is a
// stronger statement but not a durable one: either side can be edited. These
// numbers are what actually holds the port in place, so if this file goes red
// after an edit to chainPricing.ts, the port has diverged from the surface the
// web calculator prices on, and the two tools now quote different premiums for
// the same hedge on the same chain.

import { describe, it, expect } from 'vitest';
import { chainImpliedVol } from '../lib/data/chainPricing';
import { chainHedgePricing } from '../lib/data/chain-hedge-inputs';
import { nvdaChain, FIXTURE_CAPTURE_DATE } from './helpers/live-chain-fixture';

const chain = nvdaChain();
const TODAY = FIXTURE_CAPTURE_DATE;

// Full precision, as printed by the sibling implementation. Not rounded: a
// rounded golden hides exactly the kind of drift (a different bracketing cell,
// a dropped term) that this test exists to catch.
const WEB_PUT_SIGMA_1Y: Array<[number, number, string]> = [
  [0.6, 0.4630698610545937, 'interp-kt'],
  [0.7, 0.437716766971618, 'interp-kt'],
  [0.8, 0.4296725325702758, 'interp-kt'],
  [0.9, 0.43127008360703234, 'interp-kt'],
  [0.95, 0.42493736777588925, 'interp-kt'],
  [1.0, 0.42121941307743826, 'interp-kt'],
  [1.05, 0.4156560938736789, 'interp-kt'],
  [1.1, 0.37282538416351396, 'interp-kt'],
  [1.2, 0.38319609770809815, 'interp-kt'],
  [1.5, 0.4057837858239372, 'interp-t'],
];

// Same strike (20% out of the money, the tool's common floor), swept across
// tenors, so a mistake in the T-interpolation cannot hide behind a correct
// K-interpolation.
const WEB_PUT_SIGMA_AT_80PCT: Array<[number, number, string]> = [
  [0.25, 0.45273604802757084, 'interp-kt'],
  [0.5, 0.42795284980063103, 'interp-kt'],
  [1, 0.4296725325702758, 'interp-kt'],
  [2, 0.43042441360523376, 'interp-k'],
];

describe('chainImpliedVol matches the sibling implementation on a real chain', () => {
  it.each(WEB_PUT_SIGMA_1Y)(
    'put sigma at %sx spot, 1y, is the web value',
    (mult, sigma, source) => {
      const got = chainImpliedVol(chain, chain.spot * mult, 1, 'P', TODAY);
      expect(got).not.toBeNull();
      expect(got!.sigma).toBe(sigma);
      expect(got!.source).toBe(source);
    },
  );

  it.each(WEB_PUT_SIGMA_AT_80PCT)(
    'put sigma at the 20%%-OTM strike, %sy, is the web value',
    (tenor, sigma, source) => {
      const got = chainImpliedVol(chain, chain.spot * 0.8, tenor, 'P', TODAY);
      expect(got).not.toBeNull();
      expect(got!.sigma).toBe(sigma);
      expect(got!.source).toBe(source);
    },
  );

  it('the at-the-money 1y sigma is the web value', () => {
    const atm = chainImpliedVol(chain, chain.spot, 1, 'P', TODAY);
    expect(atm!.sigma).toBe(0.42121941307743826);
    // The closest-cell diagnostic travels with it and is part of the contract.
    expect(atm!.closestCell.exp).toBe('2027-09-17');
    expect(atm!.closestCell.k).toBe(214.72);
    expect(atm!.closestCell.price).toBe(31.38);
  });

  it('the call side is the web value too (the side switch is part of the port)', () => {
    const call = chainImpliedVol(chain, chain.spot * 1.1, 1, 'C', TODAY);
    expect(call!.sigma).toBe(0.4087837844306923);
    expect(call!.source).toBe('interp-kt');
  });
});

// The interpolator is one half of the port. The other half is the adapter that
// decides WHICH strike to ask about and in WHICH units - and that is the half
// where two independent implementations drift silently, because both sides
// still return a plausible sigma. It is goldened against the same web-produced
// numbers as the table above: the floor sigma must BE the web value at
// spot x (1 - protectionLevel), and a position-dollar strike must resolve the
// web value at the matching multiple of spot.
describe('chainHedgePricing maps a chain onto engine inputs the way web does', () => {
  const REQUEST = { protectionLevel: 0.2, tenorYears: 1, positionValue: 500_000, today: TODAY };

  it('prices the floor put at the web sigma for the 20%-OTM strike', () => {
    const priced = chainHedgePricing(chain, REQUEST)!;
    expect(priced.volatility).toBe(0.4296725325702758);
  });

  it('resolves a POSITION-dollar strike at the web sigma for that multiple of spot', () => {
    const priced = chainHedgePricing(chain, REQUEST)!;
    // 60% of the position is 60% of spot per share: the rescale is the unit
    // contract between the engine (position dollars) and the chain (per share).
    expect(priced.ivAtStrike(500_000 * 0.6)).toBe(0.4630698610545937);
    expect(priced.ivAtStrike(500_000 * 0.9)).toBe(0.43127008360703234);
    // And at the floor itself it agrees with `volatility`, which is what makes
    // the long leg and the spread's long leg the same option.
    expect(priced.ivAtStrike(500_000 * 0.8)).toBe(priced.volatility);
  });

  it('takes the drift from the chain, unscaled', () => {
    expect(chainHedgePricing(chain, REQUEST)!.expectedReturn).toBe(0.30755699857354757);
  });

  it('is scale-free in position value, as web is', () => {
    const small = chainHedgePricing(chain, { ...REQUEST, positionValue: 5_000 })!;
    const large = chainHedgePricing(chain, { ...REQUEST, positionValue: 5_000_000 })!;
    expect(small.volatility).toBe(large.volatility);
    expect(small.ivAtStrike(5_000 * 0.6)).toBe(large.ivAtStrike(5_000_000 * 0.6));
  });

  it('omits the drift when the chain carries no trailing return', () => {
    const young = { ...chain, historicalReturn: null };
    expect(chainHedgePricing(young, REQUEST)!.expectedReturn).toBeUndefined();
  });

  it('resolves NOTHING when the put side cannot price the floor', () => {
    const empty = { ...chain, puts: { exp: [], k: [], price: [] } };
    expect(chainHedgePricing(empty, REQUEST)).toBeNull();
  });
});

describe('the fixture carries the facts the caller reads off a chain', () => {
  it('is the schema the reader accepts, with the trailing return the calc uses as drift', () => {
    expect(chain.schemaV).toBe(3);
    expect(chain.spot).toBe(214.72);
    expect(chain.historicalReturn).toBe(0.30755699857354757);
    expect(chain.historicalReturnYears).toBe(2);
  });

  it('prices downside protection ABOVE the money, which is the whole point', () => {
    // The skew, stated as a property rather than as a number: a 20%-OTM put on
    // this real chain implies a HIGHER sigma than the at-the-money put, so a
    // flat at-the-money quote understates what that protection costs. If this
    // ever inverts on a captured chain, chain mode is buying nothing.
    const atm = chainImpliedVol(chain, chain.spot, 1, 'P', TODAY)!.sigma;
    const otm = chainImpliedVol(chain, chain.spot * 0.8, 1, 'P', TODAY)!.sigma;
    const deep = chainImpliedVol(chain, chain.spot * 0.6, 1, 'P', TODAY)!.sigma;
    expect(otm).toBeGreaterThan(atm);
    expect(deep).toBeGreaterThan(otm);
  });
});
