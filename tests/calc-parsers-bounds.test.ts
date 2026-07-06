// AlphaLatitude Inc. © 2026
//
// Range-validation coverage for the shared calc parsers. The REST endpoints
// used to compute on out-of-range inputs (negative shares, horizon > 10,
// protectionLevel > 0.5, ...) instead of rejecting them. These assert the
// parsers now enforce the same minimum/maximum the public MCP tool schemas
// declare, so the REST and MCP paths reject identically. Found by fuzzing.

import { describe, it, expect } from 'vitest';
import {
  parseAmtIsoInput,
  parseNsoInput,
  parseRsuInput,
  parseConcentrationInput,
  parseProtectivePutInput,
  parseQsbsInput,
  parseEquityFundingInput,
} from '../functions/_lib/calc-parsers';

const AMT = {
  shares: 8000, strike: 3, fmv: 40, filingStatus: 'single', ordinaryIncome: 250000,
  stateCode: 'CA', carryforwardCredit: 0, horizon: 5, cashReturnRate: 0.04,
  grantDate: '2022-03-01', hasLeftCompany: false, terminationDate: null,
  expectedGrowth: 0.12, volatility: 0.5,
};
const NSO = {
  shares: 1000, strike: 2, currentPrice: 20, ordinaryIncome: 200000, filingStatus: 'single',
  stateCode: 'CA', stillEmployed: true, holdYears: 2, holdFunding: 'cash',
  expectedSalePrice: 30, volatility: 0.4, expectedMarketReturn: 0.07,
};
const RSU = {
  shares: 2000, currentPrice: 50, ordinaryIncome: 220000, filingStatus: 'single',
  stateCode: 'CA', stillEmployed: true, holdYears: 2,
  expectedSalePrice: 60, volatility: 0.4, expectedMarketReturn: 0.07,
};
const CONC = {
  positionValue: 400000, costBasis: 100000, acquisitionDate: '2022-01-01',
  sector: 'tech_software', stateCode: 'CA', filingStatus: 'single', ordinaryIncome: 200000,
  totalAssets: 1200000, expectedPositionReturn: 0.1, expectedMarketReturn: 0.07, volatility: 0.45,
};
const PUT = { positionValue: 400000, sector: 'tech_software', protectionLevel: 0.1, tenorYears: 1, volatility: 0.4 };
const QSBS = {
  acquisitionDate: '2018-01-01', saleDate: '2026-02-01', entityType: 'us-c-corp',
  acquisitionMethod: 'original-issuance', assetCategory: 'under-50m', industry: 'tech-software',
  activeBusiness: 'yes', adjustedBasis: 10000, expectedGain: 2000000, stateCode: 'CA',
  ordinaryIncome: 250000, filingStatus: 'single',
};
const FUND = {
  targetAfterTax: 300000, targetDate: '2027-06-01', ordinaryIncome: 250000, filingStatus: 'single',
  stateCode: 'CA',
  stacks: [{ currentPrice: 50, expectedAnnualGrowth: 0.1, lots: [{ shares: 10000, costBasisPerShare: 8, acquisitionDate: '2022-01-01' }] }],
};

describe('parser range validation (rejects out-of-contract inputs)', () => {
  it('amt-iso: negative/zero and out-of-range', () => {
    expect(() => parseAmtIsoInput({ ...AMT, shares: -100 })).toThrow(/shares.*>= 1/);
    expect(() => parseAmtIsoInput({ ...AMT, shares: 1.5 })).toThrow(/shares.*whole number/);
    expect(() => parseAmtIsoInput({ ...AMT, strike: -1 })).toThrow(/strike.*>= 0/);
    expect(() => parseAmtIsoInput({ ...AMT, fmv: -1 })).toThrow(/fmv.*>= 0/);
    expect(() => parseAmtIsoInput({ ...AMT, ordinaryIncome: -1 })).toThrow(/ordinaryIncome.*>= 0/);
    expect(() => parseAmtIsoInput({ ...AMT, horizon: 99 })).toThrow(/horizon.*<= 10/);
    expect(() => parseAmtIsoInput({ ...AMT, horizon: 0 })).toThrow(/horizon.*>= 1/);
  });

  it('nso: negative shares/price and sub-1y hold', () => {
    expect(() => parseNsoInput({ ...NSO, shares: -100 })).toThrow(/shares.*>= 1/);
    expect(() => parseNsoInput({ ...NSO, currentPrice: -1 })).toThrow(/currentPrice.*>= 0/);
    expect(() => parseNsoInput({ ...NSO, holdYears: 0.5 })).toThrow(/holdYears.*>= 1/);
  });

  it('rsu: hold-window bounds (0.25..5)', () => {
    expect(() => parseRsuInput({ ...RSU, holdYears: 0.1 })).toThrow(/holdYears.*>= 0.25/);
    expect(() => parseRsuInput({ ...RSU, holdYears: 6 })).toThrow(/holdYears.*<= 5/);
    expect(() => parseRsuInput({ ...RSU, shares: -1 })).toThrow(/shares.*>= 1/);
  });

  it('concentration: negative money + hedge bounds', () => {
    expect(() => parseConcentrationInput({ ...CONC, positionValue: -1 })).toThrow(/positionValue.*>= 0/);
    expect(() => parseConcentrationInput({ ...CONC, totalAssets: -1 })).toThrow(/totalAssets.*>= 0/);
    expect(() => parseConcentrationInput({ ...CONC, hedgeChoice: { kind: 'put', protectionLevel: 5, tenorYears: 1 } })).toThrow(/protectionLevel.*<= 0.5/);
  });

  it('protective-put: protectionLevel and tenor bounds', () => {
    expect(() => parseProtectivePutInput({ ...PUT, protectionLevel: 5 })).toThrow(/protectionLevel.*<= 0.5/);
    expect(() => parseProtectivePutInput({ ...PUT, protectionLevel: 0.01 })).toThrow(/protectionLevel.*>= 0.05/);
    expect(() => parseProtectivePutInput({ ...PUT, tenorYears: 0.1 })).toThrow(/tenorYears.*>= 0.25/);
    expect(() => parseProtectivePutInput({ ...PUT, positionValue: -1 })).toThrow(/positionValue.*>= 0/);
  });

  it('qsbs: negative basis', () => {
    expect(() => parseQsbsInput({ ...QSBS, adjustedBasis: -1 })).toThrow(/adjustedBasis.*>= 0/);
  });

  it('equity-funding: negative target, shortfall range, lot shares', () => {
    expect(() => parseEquityFundingInput({ ...FUND, targetAfterTax: -1 })).toThrow(/targetAfterTax.*>= 0/);
    expect(() => parseEquityFundingInput({ ...FUND, riskToleranceShortfall: 2 })).toThrow(/riskToleranceShortfall.*<= 1/);
    expect(() => parseEquityFundingInput({
      ...FUND,
      stacks: [{ currentPrice: 50, expectedAnnualGrowth: 0.1, lots: [{ shares: -5, costBasisPerShare: 8, acquisitionDate: '2022-01-01' }] }],
    })).toThrow(/shares.*>= 1/);
  });
});

describe('parser range validation (accepts in-contract boundary values)', () => {
  it('accepts boundary-valid inputs unchanged', () => {
    expect(() => parseAmtIsoInput({ ...AMT, horizon: 10 })).not.toThrow();
    expect(() => parseAmtIsoInput({ ...AMT, horizon: 1 })).not.toThrow();
    expect(() => parseRsuInput({ ...RSU, holdYears: 0.25 })).not.toThrow();
    expect(() => parseRsuInput({ ...RSU, holdYears: 5 })).not.toThrow();
    expect(() => parseProtectivePutInput({ ...PUT, protectionLevel: 0.05 })).not.toThrow();
    expect(() => parseProtectivePutInput({ ...PUT, protectionLevel: 0.5 })).not.toThrow();
    // strike/basis of exactly 0 is allowed by the schema (minimum: 0).
    expect(() => parseAmtIsoInput({ ...AMT, strike: 0 })).not.toThrow();
  });
});

describe('parser stateCode validation (rejects codes the tax engine cannot model)', () => {
  // Regression for the silent-$0-state-tax defect: stateCode was `p.str` with
  // an `^[A-Z]{2}$` schema, so a typo or non-state code ("ZZ", "PR", "UK", or a
  // transposed "AC") passed validation and produced $0 state tax with no error.
  // It is now validated against the 50 states + DC the engine actually models.
  it('rejects unknown / mistyped two-letter codes across every tool', () => {
    for (const bad of ['ZZ', 'PR', 'UK', 'AC']) {
      expect(() => parseAmtIsoInput({ ...AMT, stateCode: bad })).toThrow(/stateCode.*must be one of/);
      expect(() => parseNsoInput({ ...NSO, stateCode: bad })).toThrow(/stateCode.*must be one of/);
      expect(() => parseRsuInput({ ...RSU, stateCode: bad })).toThrow(/stateCode.*must be one of/);
      expect(() => parseConcentrationInput({ ...CONC, stateCode: bad })).toThrow(/stateCode.*must be one of/);
      expect(() => parseQsbsInput({ ...QSBS, stateCode: bad })).toThrow(/stateCode.*must be one of/);
    }
  });

  it('accepts every real state including no-income-tax states (TX, FL, WA)', () => {
    for (const ok of ['CA', 'NY', 'TX', 'FL', 'WA', 'DC']) {
      expect(() => parseAmtIsoInput({ ...AMT, stateCode: ok })).not.toThrow();
      expect(() => parseNsoInput({ ...NSO, stateCode: ok })).not.toThrow();
    }
  });
});
