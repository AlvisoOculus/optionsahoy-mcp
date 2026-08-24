// AlphaLatitude Inc. © 2026
//
// Chain mode for protective_put_price: when the caller names a ticker whose
// live chain we can fetch, every leg is priced at the implied volatility of
// its own strike instead of at one flat sigma.
//
// Two things are under test here, and they are different things:
//
//   1. THE WIRING. The parser is the single point of resolution, so it decides
//      the sigma, the strike-level lookup, the drift, the label AND the two
//      provenance fields, in one place, from one ladder. What this file pins is
//      that the ladder's order never changes: an explicit input always wins,
//      resolution only ever fills a gap.
//
//   2. THE FALLBACK MATRIX. Chain mode is an upgrade on a path that already
//      worked, so every way it can fail has to land exactly where the call
//      landed before this feature existed - same sigma ladder, same numbers,
//      `pricingMode: "flat"` - and never on an error. No ticker, a fetch that
//      failed, a stale chain, a schema we do not read, a surface too sparse to
//      interpolate: all of them are ONE outcome.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseProtectivePutInput, warmForCall, chainTickerFor } from '../functions/_lib/calc-parsers';
import { calculateProtectivePut } from '@/lib/calc/protectivePut';
import { chainImpliedVol } from '../lib/data/chainPricing';
import { __setChainsForTests, getLiveChain } from '../lib/data/live-chain';
import { __setVolSnapshotForTests } from '../lib/data/live-vols';
import { onRequest as qsbsHandler } from '../functions/api/v1/qsbs';
import { onRequest as ppHandler } from '../functions/api/v1/protective-put';
import {
  cutoffSeconds,
  freshNvdaChain,
  nvdaChain,
  seedFreshChain,
  seedNoChains,
} from './helpers/live-chain-fixture';
import { seedFreshVols, FIXTURE_VOLS } from './helpers/live-vols-fixture';

// The call every test below varies one field of. `sector` is required by the
// tool and stays put: in chain mode it stops driving the sigma, but it is still
// the caller's stated fact and still the fallback when everything else fails.
const PP = {
  positionValue: 500_000,
  sector: 'tech_software',
  protectionLevel: 0.2,
  tenorYears: 1,
  ticker: 'NVDA',
};

// tech_software annualVol x IV_OVER_RV_MULTIPLIER, i.e. the last rung.
const SECTOR_DEFAULT = parseProtectivePutInput({ ...PP, ticker: 'NOSUCHTICKER' }).volatility;

// The chain the parser will actually read, not a fresh copy of the fixture.
// Both matter: the interpolator reads today's clock for its tenors, and it
// memoizes the built surface per chain-side object, so comparing against the
// SAME object is what makes these assertions exact instead of within-epsilon.
// (The fixed-date golden numbers live in tests/chain-pricing-golden.test.ts.)
const seededChain = () => getLiveChain('NVDA')!;

// What the port says the 20%-OTM NVDA put implies, at the tenor being priced.
// Recomputed rather than hardcoded because the fixture's expirations march one
// day closer with every day the suite runs.
function fixtureSigmaAtFloor(protectionLevel = PP.protectionLevel, tenorYears = PP.tenorYears): number {
  const chain = seededChain();
  return chainImpliedVol(chain, chain.spot * (1 - protectionLevel), tenorYears, 'P')!.sigma;
}

beforeEach(() => {
  seedFreshVols();
  seedFreshChain();
});

afterEach(() => {
  vi.unstubAllGlobals();
  seedNoChains();
});

describe('chain mode, when the chain resolves', () => {
  it('prices the floor put at ITS OWN strike sigma and says so', () => {
    const out = parseProtectivePutInput(PP);
    expect(out.pricingMode).toBe('chain-skew');
    expect(out.volatilitySource).toBe('chain');
    expect(out.volatility).toBe(fixtureSigmaAtFloor());
  });

  it('does not price it at the published at-the-money sigma', () => {
    // The whole point: the vols artifact is warm and covers NVDA, and chain
    // mode still does not use it, because a 20%-OTM put does not trade at the
    // at-the-money vol.
    const out = parseProtectivePutInput(PP);
    expect(out.volatility).not.toBe(FIXTURE_VOLS.NVDA);
    expect(out.volatility).toBeGreaterThan(0);
  });

  it('hands the engine a strike-level lookup, in POSITION dollars', () => {
    const out = parseProtectivePutInput(PP);
    expect(typeof out.ivAtStrike).toBe('function');
    const chain = seededChain();
    // A strike at 60% of the position must resolve the sigma the chain implies
    // at 60% of SPOT: the engine works in position dollars and the chain in
    // per-share dollars, and the rescale is what keeps them the same strike.
    const deep = out.ivAtStrike!(PP.positionValue * 0.6);
    expect(deep).toBe(chainImpliedVol(chain, chain.spot * 0.6, PP.tenorYears, 'P')!.sigma);
    // And the skew is real on this chain: deeper is dearer.
    expect(deep!).toBeGreaterThan(out.volatility);
  });

  it('is scale-free: the same ticker prices at one sigma for any position size', () => {
    const small = parseProtectivePutInput({ ...PP, positionValue: 5_000 });
    const large = parseProtectivePutInput({ ...PP, positionValue: 5_000_000 });
    expect(small.volatility).toBe(large.volatility);
    expect(small.ivAtStrike!(5_000 * 0.6)).toBe(large.ivAtStrike!(5_000_000 * 0.6));
  });

  it("takes the drift from the chain's trailing return", () => {
    const out = parseProtectivePutInput(PP);
    expect(out.expectedReturn).toBe(nvdaChain().historicalReturn);
    expect(calculateProtectivePut(out).realWorldDrift).toBe(nvdaChain().historicalReturn);
  });

  it('still echoes the ticker as the label', () => {
    expect(parseProtectivePutInput(PP).tickerLabel).toBe('NVDA');
  });

  it('costs MORE than the flat quote for the same hedge, which is the skew', () => {
    // The claim chain mode makes, in dollars: a flat at-the-money sigma
    // understates what out-of-the-money protection costs.
    const chain = seededChain();
    const atm = chainImpliedVol(chain, chain.spot, PP.tenorYears, 'P')!.sigma;
    const skewed = calculateProtectivePut(parseProtectivePutInput(PP));
    const flat = calculateProtectivePut(
      parseProtectivePutInput({ ...PP, volatility: atm }),
    );
    expect(skewed.inputs.pricingMode).toBe('chain-skew');
    expect(flat.inputs.pricingMode).toBe('flat');
    expect(skewed.barePut.premium).toBeGreaterThan(flat.barePut.premium);
  });

  it("prices the spread's short leg at ITS strike, not the long leg's", () => {
    const skewed = calculateProtectivePut(parseProtectivePutInput(PP));
    expect(skewed.putSpread.shortSigma).not.toBe(skewed.inputs.volatility);
    expect(skewed.putSpread.shortSigma).toBe(
      skewed.inputs.ivAtStrike!(skewed.putSpread.shortStrike),
    );
  });

  it('reaches the wire through REST, provenance and all', async () => {
    const res = await ppHandler({
      request: new Request('http://localhost/api/v1/protective-put', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PP),
      }),
    } as never);
    const json = (await res.json()) as { result: { inputs: Record<string, unknown> } };
    expect(json.result.inputs.pricingMode).toBe('chain-skew');
    expect(json.result.inputs.volatilitySource).toBe('chain');
    // The closure is not JSON, and must not become a broken key on the wire.
    expect('ivAtStrike' in json.result.inputs).toBe(false);
  });
});

describe('explicit input always wins', () => {
  it('an explicit volatility keeps the WHOLE quote flat', () => {
    const out = parseProtectivePutInput({ ...PP, volatility: 0.31 });
    expect(out.volatility).toBe(0.31);
    expect(out.volatilitySource).toBe('explicit');
    expect(out.pricingMode).toBe('flat');
    // Not "flat for the long leg, skewed for the short one": a caller who gave
    // us a number gets that number on every leg, or the short leg would come
    // back priced at a sigma they never chose.
    expect(out.ivAtStrike).toBeUndefined();
  });

  it('an explicit expectedReturn beats the chain trailing return', () => {
    const out = parseProtectivePutInput({ ...PP, expectedReturn: 0.07 });
    expect(out.expectedReturn).toBe(0.07);
    expect(out.pricingMode).toBe('chain-skew');
  });

  it('an explicit tickerLabel beats the symbol', () => {
    expect(parseProtectivePutInput({ ...PP, tickerLabel: 'Nvidia' }).tickerLabel).toBe('Nvidia');
  });
});

describe('the fallback matrix: every failure is the SAME failure', () => {
  const flat = (over: Record<string, unknown> = {}) => parseProtectivePutInput({ ...PP, ...over });

  it('no ticker -> flat, at the sector-typical sigma', () => {
    const { ticker: _t, ...noTicker } = PP;
    const out = parseProtectivePutInput(noTicker);
    expect(out.pricingMode).toBe('flat');
    expect(out.volatilitySource).toBe('sector-default');
    expect(out.volatility).toBe(SECTOR_DEFAULT);
    expect(out.ivAtStrike).toBeUndefined();
  });

  it('fetch failed or timed out -> flat, at the published at-the-money sigma', () => {
    seedNoChains();
    const out = flat();
    expect(out.pricingMode).toBe('flat');
    expect(out.volatilitySource).toBe('ticker');
    expect(out.volatility).toBe(FIXTURE_VOLS.NVDA);
    expect(out.ivAtStrike).toBeUndefined();
  });

  it('remembered failure -> flat', () => {
    __setChainsForTests({ NVDA: null });
    expect(flat().pricingMode).toBe('flat');
  });

  it('STALE chain (the budget-exhausted serve) -> flat', () => {
    __setChainsForTests({ NVDA: { ...nvdaChain(), asOf: cutoffSeconds() - 1 } });
    const out = flat();
    expect(out.pricingMode).toBe('flat');
    expect(out.volatilitySource).toBe('ticker');
    expect(out.ivAtStrike).toBeUndefined();
  });

  it('schema mismatch -> flat', () => {
    __setChainsForTests({ NVDA: { ...freshNvdaChain(), schemaV: 99 } });
    expect(flat().pricingMode).toBe('flat');
  });

  it('a chain with no usable put cells -> flat, all of it', () => {
    // Not "chain mode with a hole in it". If the surface cannot price the leg
    // the caller asked about, it does not get to price the others either.
    const empty = freshNvdaChain();
    empty.puts = { exp: [], k: [], price: [] };
    __setChainsForTests({ NVDA: empty });
    const out = flat();
    expect(out.pricingMode).toBe('flat');
    expect(out.volatilitySource).toBe('ticker');
    expect(out.ivAtStrike).toBeUndefined();
  });

  it('every fallback reproduces the pre-chain answer EXACTLY', () => {
    // The regression this guards: chain mode is new behaviour on a path that
    // already had a documented answer. Where the chain does not apply, the
    // numbers must be the ones the tool has always returned.
    const priced = calculateProtectivePut(parseProtectivePutInput({ ...PP, volatility: 0.35 }));
    seedNoChains();
    const same = calculateProtectivePut(parseProtectivePutInput({ ...PP, volatility: 0.35 }));
    expect(JSON.stringify(same)).toBe(JSON.stringify(priced));
  });

  it('an unresolvable ticker with no chain and no vols is still a priced answer', () => {
    // The no-defaults contract stops at this tool: sector is required, so a
    // sector-typical estimate is always available and disclosed. Chain mode
    // must not have turned any of that into an error.
    seedNoChains();
    __setVolSnapshotForTests(null);
    const out = parseProtectivePutInput(PP);
    expect(out.volatilitySource).toBe('sector-default');
    expect(out.pricingMode).toBe('flat');
    expect(calculateProtectivePut(out).barePut.premium).toBeGreaterThan(0);
  });
});

// The engine's own per-leg behaviour, verified rather than assumed: the parser
// hands over ONE closure for every strike, so if a strike ever resolves nothing
// the engine has to price that leg at the flat sigma by itself.
describe('the engine falls back per leg when ivAtStrike resolves nothing', () => {
  const base = {
    positionValue: 500_000,
    sector: 'tech_software' as const,
    volatility: 0.4,
    protectionLevel: 0.2,
    tenorYears: 1,
  };

  it("uses the flat sigma for the spread's short leg when the lookup returns null", () => {
    const withNulls = calculateProtectivePut({ ...base, ivAtStrike: () => null });
    const flat = calculateProtectivePut(base);
    expect(withNulls.putSpread.shortSigma).toBe(base.volatility);
    expect(JSON.stringify(withNulls.putSpread)).toBe(JSON.stringify(flat.putSpread));
  });

  it('also rejects a lookup that returns a nonsense sigma', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const out = calculateProtectivePut({ ...base, ivAtStrike: () => bad });
      expect(out.putSpread.shortSigma, String(bad)).toBe(base.volatility);
    }
  });
});

describe('the chain is fetched for THIS tool only, and only when it can be read', () => {
  it('names the ticker for a protective-put call and nothing else', () => {
    expect(chainTickerFor('protective_put_price', PP)).toBe('NVDA');
    expect(chainTickerFor('protective-put', PP)).toBe('NVDA');
    // Every other tool prices at a single sigma by construction: a chain would
    // buy them nothing and cost their every ticker call a round-trip.
    for (const tool of [
      'qsbs_check',
      'concentration_analyze',
      'amt_iso_optimize',
      'nso_calculate',
      'rsu_sell_vs_hold',
      'equity_funding_plan',
      'rsu_lot_optimize',
      'not_a_tool',
      'toString',
    ]) {
      expect(chainTickerFor(tool, { ...PP }), tool).toBeNull();
    }
  });

  it('names nothing when the caller supplied a volatility, or no ticker', () => {
    expect(chainTickerFor('protective_put_price', { ...PP, volatility: 0.3 })).toBeNull();
    const { ticker: _t, ...noTicker } = PP;
    expect(chainTickerFor('protective_put_price', noTicker)).toBeNull();
    expect(chainTickerFor('protective_put_price', { ...PP, ticker: '  ' })).toBeNull();
    expect(chainTickerFor('protective_put_price', null)).toBeNull();
    expect(chainTickerFor('protective_put_price', 'nope')).toBeNull();
  });

  // ── The teeth ──────────────────────────────────────────────────────────
  // Unsealed, over a fetch spy: the gate is only worth having if a call that
  // cannot read a chain never asks for one. A qsbs_check carrying a ticker is
  // the case that pays nothing and must fetch nothing.
  describe('over a real fetch spy', () => {
    let spy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      seedNoChains();
      spy = vi.fn(async (url: string) => {
        if (String(url).includes('/chains/fetch/')) {
          return new Response(JSON.stringify(freshNvdaChain()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      });
      vi.stubGlobal('fetch', spy);
    });

    const chainCalls = () =>
      spy.mock.calls.filter((c) => String(c[0]).includes('/chains/fetch/')).length;

    it('fetches exactly one chain for a protective-put call with a ticker', async () => {
      await warmForCall('protective_put_price', PP);
      expect(chainCalls()).toBe(1);
      expect(String(spy.mock.calls.find((c) => String(c[0]).includes('/chains/fetch/'))![0]))
        .toBe('https://data.optionsahoy.com/chains/fetch/NVDA');
    });

    it('fetches NO chain for any other tool, ticker or not', async () => {
      const QSBS = {
        acquisitionDate: '2020-03-01',
        saleDate: '2026-03-15',
        entityType: 'us-c-corp',
        acquisitionMethod: 'original-issuance',
        assetCategory: 'under-50m',
        industry: 'tech-software',
        activeBusiness: 'yes',
        adjustedBasis: 50_000,
        expectedGain: 5_000_000,
        stateCode: 'CA',
        ordinaryIncome: 250_000,
        filingStatus: 'single',
        ticker: 'NVDA',
      };
      await warmForCall('qsbs_check', QSBS);
      await warmForCall('concentration_analyze', { ...PP, costBasis: 1 });
      await warmForCall('amt_iso_optimize', { shares: 100, ticker: 'NVDA' });
      expect(chainCalls()).toBe(0);

      // And through the transport, not just the gate: a real REST request for
      // a tool with no chain path must not touch the chains worker.
      await qsbsHandler({
        request: new Request('http://localhost/api/v1/qsbs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(QSBS),
        }),
      } as never);
      expect(chainCalls()).toBe(0);
    });

    it('fetches no chain when the caller passed a volatility', async () => {
      await warmForCall('protective_put_price', { ...PP, volatility: 0.3 });
      expect(chainCalls()).toBe(0);
    });
  });
});
