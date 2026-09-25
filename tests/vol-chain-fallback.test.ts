// AlphaLatitude Inc. © 2026
//
// The single-sigma tools' fallback for a ticker chains/vols.json does not
// carry (DGRO, NXTT in the week to 2026-09-24: "field volatility required").
//
// The worker computes that ticker's ATM 1y sigma whenever it serves the chain,
// with the same function that fills vols.json, and states it in the
// `x-oa-atm-iv-1y` response header. The file itself cannot answer in time: the
// worker folds an on-demand ticker in after responding, and the file is
// CDN-cached. So on a vols.json miss, warmForCall fetches the chain and the
// parsers read the header's sigma (getChainAtmVol).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseAmtIsoInput,
  parseConcentrationInput,
  parseNsoInput,
  parseRsuInput,
  warmForCall,
} from '../functions/_lib/calc-parsers';
import { ATM_IV_HEADER, getChainAtmVol, warmChain, __setChainsForTests } from '../lib/data/live-chain';
import { VOLS_URL } from '../lib/data/live-vols';
import { clearVols, cutoffSeconds as volsCutoff, seedFreshVols, volsArtifact } from './helpers/live-vols-fixture';
import { cutoffSeconds, freshNvdaChain, nvdaChain, seedNoChains } from './helpers/live-chain-fixture';
import { jsonResponse, stubFetch } from './helpers/stub-fetch';

const CHAIN_SIGMA = 0.3817;

const AMT = {
  shares: 10000, strike: 2, fmv: 200, expectedGrowth: 0.15,
  filingStatus: 'married_joint', ordinaryIncome: 400000, stateCode: 'CA',
  carryforwardCredit: 0, horizon: 4, cashReturnRate: 0.05,
  grantDate: '2022-01-15', hasLeftCompany: false, terminationDate: null,
};
const NSO = {
  shares: 1000, strike: 5, currentPrice: 50, ordinaryIncome: 200000,
  filingStatus: 'single', stateCode: 'CA', stillEmployed: true, holdYears: 3,
  expectedSalePrice: 80, expectedMarketReturn: 0.07, holdFunding: 'cash',
};
const RSU = {
  shares: 500, currentPrice: 80, ordinaryIncome: 200000, filingStatus: 'single',
  stateCode: 'CA', stillEmployed: true, holdYears: 2, expectedSalePrice: 100,
  expectedMarketReturn: 0.07,
};
const CONC = {
  positionValue: 1000000, costBasis: 200000, acquisitionDate: '2022-01-15',
  sector: 'tech_software', stateCode: 'CA', filingStatus: 'single',
  ordinaryIncome: 250000, totalAssets: 1500000, expectedPositionReturn: 0.1,
  expectedMarketReturn: 0.07,
};

// NVDA is the chain fixture's symbol; these tests publish a vols file WITHOUT
// it, which is exactly the uncovered-ticker case.
const UNCOVERED = { AAPL: 0.2731 };

const SINGLE_SIGMA_TOOLS: [string, string, (raw: unknown) => unknown, object][] = [
  ['amt_iso_optimize', 'amt-iso', parseAmtIsoInput, AMT],
  ['nso_calculate', 'nso', parseNsoInput, NSO],
  ['rsu_sell_vs_hold', 'rsu-sell-vs-hold', parseRsuInput, RSU],
  ['concentration_analyze', 'concentration', parseConcentrationInput, CONC],
];

function chainWithHeader(iv: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (iv !== null) headers[ATM_IV_HEADER] = iv;
  return new Response(JSON.stringify(freshNvdaChain()), { status: 200, headers });
}

beforeEach(() => {
  seedNoChains();
  clearVols();
});

afterEach(() => {
  vi.unstubAllGlobals();
  seedNoChains();
  clearVols();
});

describe('parsers: the chain-stated sigma resolves an uncovered ticker', () => {
  for (const [tool, , parse, base] of SINGLE_SIGMA_TOOLS) {
    it(`${tool}: resolves with it, and errors without it`, () => {
      seedFreshVols(UNCOVERED);
      expect(() => parse({ ...base, ticker: 'NVDA' })).toThrow(/field "volatility" required/);

      __setChainsForTests({ NVDA: freshNvdaChain() }, Date.now(), { NVDA: CHAIN_SIGMA });
      expect(() => parse({ ...base, ticker: 'NVDA' })).not.toThrow();
    });
  }

  it('is the sigma the tool actually uses', () => {
    seedFreshVols(UNCOVERED);
    __setChainsForTests({ NVDA: freshNvdaChain() }, Date.now(), { NVDA: CHAIN_SIGMA });
    const withTicker = parseConcentrationInput({ ...CONC, ticker: 'NVDA' });
    const explicit = parseConcentrationInput({ ...CONC, volatility: CHAIN_SIGMA });
    expect(withTicker).toMatchObject({ volatility: CHAIN_SIGMA });
    expect((withTicker as { volatilityDrag: number }).volatilityDrag)
      .toBe((explicit as { volatilityDrag: number }).volatilityDrag);
  });

  it('never outranks the published file', () => {
    seedFreshVols({ NVDA: 0.4447 });
    __setChainsForTests({ NVDA: freshNvdaChain() }, Date.now(), { NVDA: CHAIN_SIGMA });
    expect(parseConcentrationInput({ ...CONC, ticker: 'NVDA' })).toMatchObject({ volatility: 0.4447 });
  });

  it('is refused with a stale chain, like the chain itself', () => {
    __setChainsForTests({ NVDA: { ...nvdaChain(), asOf: cutoffSeconds() - 1 } }, Date.now(), { NVDA: CHAIN_SIGMA });
    expect(getChainAtmVol('NVDA')).toBeNull();
    seedFreshVols(UNCOVERED);
    expect(() => parseNsoInput({ ...NSO, ticker: 'NVDA' })).toThrow(/field "volatility" required/);
  });
});

describe('warmChain reads the header', () => {
  it('keeps a sane sigma', async () => {
    stubFetch(() => chainWithHeader(String(CHAIN_SIGMA)));
    await warmChain('NVDA');
    expect(getChainAtmVol('NVDA')).toBe(CHAIN_SIGMA);
  });

  for (const bad of [null, '', 'abc', '0', '-0.2', '7', 'NaN', 'Infinity']) {
    it(`resolves nothing from header ${JSON.stringify(bad)}`, async () => {
      stubFetch(() => chainWithHeader(bad));
      await warmChain('NVDA');
      expect(getChainAtmVol('NVDA')).toBeNull();
    });
  }
});

describe('warmForCall: fetch the chain only on a vols.json miss', () => {
  function stubBoth(vols: Record<string, number>) {
    return stubFetch((url) => {
      if (url === VOLS_URL) return jsonResponse(volsArtifact(volsCutoff(), vols));
      if (url.endsWith('/chains/fetch/NVDA')) return chainWithHeader(String(CHAIN_SIGMA));
      return new Response('not found', { status: 404 });
    });
  }
  const chainCalls = (spy: ReturnType<typeof stubFetch>) =>
    (spy.mock.calls as unknown as [string][]).filter(([u]) => u.includes('/chains/fetch/')).length;

  for (const [tool, slug, parse, base] of SINGLE_SIGMA_TOOLS) {
    for (const key of [tool, slug]) {
      it(`${key}: an uncovered ticker is fetched and then resolves`, async () => {
        const spy = stubBoth(UNCOVERED);
        await warmForCall(key, { ...base, ticker: 'NVDA' });
        expect(chainCalls(spy)).toBe(1);
        expect(() => parse({ ...base, ticker: 'NVDA' })).not.toThrow();
      });
    }

    it(`${tool}: a covered ticker costs no chain fetch`, async () => {
      const spy = stubBoth({ NVDA: 0.4447 });
      await warmForCall(tool, { ...base, ticker: 'NVDA' });
      expect(chainCalls(spy)).toBe(0);
    });

    it(`${tool}: an explicit volatility costs no fetch at all`, async () => {
      const spy = stubBoth(UNCOVERED);
      expect(warmForCall(tool, { ...base, ticker: 'NVDA', volatility: 0.3 })).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it('protective_put_price still fetches its chain alongside the file, not after it', async () => {
    const spy = stubBoth({ NVDA: 0.4447 });
    await warmForCall('protective_put_price', { positionValue: 500000, sector: 'tech_software', protectionLevel: 0.2, tenorYears: 1, ticker: 'NVDA' });
    expect(chainCalls(spy)).toBe(1);
  });
});
