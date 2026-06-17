// AlphaLatitude Inc. © 2026
//
// End-to-end coverage for the remaining /api/v1/* endpoints. For each
// endpoint we send one valid request and assert the response body is
// byte-identical to what the in-process calculator returns. That keeps
// the deployed API and the in-browser tools in lockstep.
//
// Error-path coverage (400/405/OPTIONS) lives in api-v1-amt-iso.test.ts,
// which exercises the shared runCalc helper.

import { describe, it, expect } from 'vitest';
import { onRequest as nsoHandler } from '../functions/api/v1/nso';
import { onRequest as rsuHandler } from '../functions/api/v1/rsu-sell-vs-hold';
import { onRequest as concHandler } from '../functions/api/v1/concentration';
import { onRequest as ppHandler } from '../functions/api/v1/protective-put';
import { onRequest as qsbsHandler } from '../functions/api/v1/qsbs';
import { onRequest as indexHandler } from '../functions/api/v1/index';

import { computeNsoResult } from '@/lib/calc/nso';
import { computeRsuResult } from '@/lib/calc/rsu';
import { calculate as computeConcentration } from '@/lib/calc/concentration';
import { calculateProtectivePut } from '@/lib/calc/protectivePut';
import { evaluateQsbs } from '@/lib/calc/qsbs';
import { lognormalHaircut } from '@/lib/calc/volatility-drag';

function postReq(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function expectOkAndMatch<T>(
  res: Response,
  reference: T,
): Promise<void> {
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; result: unknown };
  expect(json.ok).toBe(true);
  expect(JSON.stringify(json.result)).toEqual(JSON.stringify(reference));
}

// REST handlers derive `haircut` from `volatility` via the parser; in-process
// calc functions skip the parser, so the test must apply the same derivation.
describe('POST /api/v1/nso', () => {
  it('matches in-process computeNsoResult', async () => {
    const body = {
      shares: 5000,
      strike: 8,
      currentPrice: 75,
      ordinaryIncome: 250000,
      filingStatus: 'single',
      stateCode: 'CA',
      stillEmployed: true,
      holdYears: 1,
      expectedSalePrice: 90,
      volatility: 0.3,
      expectedMarketReturn: 0.07,
      holdFunding: 'sell-to-cover',
    };
    const res = await nsoHandler({ request: postReq('/api/v1/nso', body) });
    await expectOkAndMatch(res, computeNsoResult({
      ...body,
      haircut: lognormalHaircut(body.volatility, body.holdYears),
      filingStatus: 'single',
    } as Parameters<typeof computeNsoResult>[0]));
  });
});

describe('POST /api/v1/rsu-sell-vs-hold', () => {
  it('matches in-process computeRsuResult', async () => {
    const body = {
      shares: 1000,
      currentPrice: 200,
      ordinaryIncome: 300000,
      filingStatus: 'married_joint',
      stateCode: 'NY',
      stillEmployed: true,
      holdYears: 1.5,
      expectedSalePrice: 220,
      volatility: 0.25,
      expectedMarketReturn: 0.07,
    };
    const res = await rsuHandler({ request: postReq('/api/v1/rsu-sell-vs-hold', body) });
    await expectOkAndMatch(
      res,
      computeRsuResult({
        ...body,
        haircut: lognormalHaircut(body.volatility, body.holdYears),
        filingStatus: 'married_joint',
      } as Parameters<typeof computeRsuResult>[0]),
    );
  });
});

describe('POST /api/v1/concentration', () => {
  it('matches in-process calculate', async () => {
    const body = {
      positionValue: 1000000,
      costBasis: 200000,
      acquisitionDate: '2022-01-15',
      sector: 'tech_software',
      stateCode: 'CA',
      filingStatus: 'single',
      ordinaryIncome: 250000,
      totalAssets: 1500000,
      expectedPositionReturn: 0.1,
      expectedMarketReturn: 0.07,
      volatilityDrag: 0.2,
    };
    const res = await concHandler({ request: postReq('/api/v1/concentration', body) });
    const reference = computeConcentration({
      ...body,
      acquisitionDate: new Date('2022-01-15'),
    } as Parameters<typeof computeConcentration>[0]);
    await expectOkAndMatch(res, reference);
  });
});

describe('POST /api/v1/protective-put', () => {
  it('matches in-process calculateProtectivePut', async () => {
    const body = {
      positionValue: 500000,
      sector: 'tech_software',
      volatility: 0.35,
      protectionLevel: 0.2,
      tenorYears: 1,
    };
    const res = await ppHandler({ request: postReq('/api/v1/protective-put', body) });
    await expectOkAndMatch(res, calculateProtectivePut(body as Parameters<typeof calculateProtectivePut>[0]));
  });
});

describe('POST /api/v1/qsbs', () => {
  it('matches in-process evaluateQsbs', async () => {
    const body = {
      acquisitionDate: '2020-03-01',
      saleDate: '2026-03-15',
      entityType: 'us-c-corp',
      acquisitionMethod: 'original-issuance',
      assetCategory: 'under-50m',
      industry: 'tech-software',
      activeBusiness: 'yes',
      adjustedBasis: 50000,
      expectedGain: 5000000,
      stateCode: 'CA',
      ordinaryIncome: 300000,
      filingStatus: 'single',
    };
    const res = await qsbsHandler({ request: postReq('/api/v1/qsbs', body) });
    const reference = evaluateQsbs({
      ...body,
      acquisitionDate: new Date('2020-03-01'),
      saleDate: new Date('2026-03-15'),
    } as Parameters<typeof evaluateQsbs>[0]);
    await expectOkAndMatch(res, reference);
  });

  const qsbsBase = {
    acquisitionDate: new Date('2018-03-01'),
    saleDate: new Date('2024-06-01'),
    entityType: 'us-c-corp',
    acquisitionMethod: 'original-issuance',
    assetCategory: 'under-50m',
    industry: 'tech-software',
    activeBusiness: 'yes',
    adjustedBasis: 100000,
    expectedGain: 5000000,
    stateCode: 'TX',
    ordinaryIncome: 300000,
    filingStatus: 'single',
  } as Parameters<typeof evaluateQsbs>[0];

  it('emits cappedOverageNote when the gain exceeds the exclusion cap', () => {
    // $40M gain, $10M per-issuer cap (10x basis only $1M) -> $30M overage.
    const r = evaluateQsbs({ ...qsbsBase, expectedGain: 40000000 });
    expect(r.applicableCap).toBe(10000000);
    expect(r.cappedOverageNote).toBeDefined();
    expect(r.cappedOverageNote).toContain('$10M');
    expect(r.cappedOverageNote).toContain('$30M');
    expect(r.cappedOverageNote).toContain('estate-planning attorney');
  });

  it('omits cappedOverageNote when the gain fits under the cap', () => {
    // $5M gain, fully excluded, no overage.
    const r = evaluateQsbs({ ...qsbsBase, expectedGain: 5000000 });
    expect(r.taxableGain).toBe(0);
    expect(r.cappedOverageNote).toBeUndefined();
  });

  it('references the 10x-basis cap (and a fractional $M) when that cap is binding', () => {
    // basis $1.35M -> 10x cap $13.5M beats the $10M per-issuer cap; gain $20M -> overage $6.5M.
    // Also exercises fmtMillions' decimal branch, which the round-$M cases above miss.
    const r = evaluateQsbs({ ...qsbsBase, adjustedBasis: 1350000, expectedGain: 20000000 });
    expect(r.applicableCap).toBe(13500000);
    expect(r.cappedOverageNote).toContain('$13.5M');
    expect(r.cappedOverageNote).toContain('$6.5M');
  });

  it('omits cappedOverageNote on a disqualified verdict even with a huge gain', () => {
    // appliedExclusion === 0 -> no exclusion in play, so no stacking guidance.
    const r = evaluateQsbs({ ...qsbsBase, entityType: 'other', expectedGain: 40000000 });
    expect(r.verdict).toBe('disqualified');
    expect(r.cappedOverageNote).toBeUndefined();
  });

  it('omits cappedOverageNote when taxable gain is a partial-tier haircut, not a cap overage', () => {
    // OBBBA 4-year hold -> 75% tier; gain under the $15M cap. The taxable 25%
    // is from the tier, not a cap overage, so stacking guidance must not fire.
    const r = evaluateQsbs({
      ...qsbsBase,
      acquisitionDate: new Date('2025-08-01'),
      saleDate: new Date('2029-09-01'),
      expectedGain: 4000000,
    });
    expect(r.exclusionPercent).toBe(0.75);
    expect(r.taxableGain).toBeGreaterThan(0);
    expect(r.cappedOverageNote).toBeUndefined();
  });
});

describe('GET /api/v1', () => {
  it('returns endpoint inventory', async () => {
    const res = await indexHandler({
      request: new Request('http://localhost/api/v1', { method: 'GET' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { endpoints: Array<{ path: string }> };
    expect(json.endpoints).toHaveLength(7);
    expect(json.endpoints.map((e) => e.path).sort()).toEqual([
      '/api/v1/amt-iso',
      '/api/v1/concentration',
      '/api/v1/nso',
      '/api/v1/protective-put',
      '/api/v1/qsbs',
      '/api/v1/rsu-sell-vs-hold',
      '/api/v1/stats',
    ]);
  });
});
