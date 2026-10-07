// AlphaLatitude Inc. © 2026
//
// End-to-end test for /api/v1/amt-iso. Calls the Pages Function handler
// directly with a mock Request, asserts the JSON shape, and verifies the
// result matches what computeAmtIso returns when called in-process. If
// these stay in sync the deployed endpoint behaves the same as the
// in-browser calculator.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/api/v1/amt-iso';
import { computeAmtIso, type AmtIsoInput } from '@/lib/calc/amtIso';
import { VALID_AMT_ISO_BODY as VALID_BODY, makeAmtIsoReq as makeReq } from './helpers/amt-iso-fixture';

describe('POST /api/v1/amt-iso', () => {
  it('returns the same result as computeAmtIso called in-process', async () => {
    const res = await onRequest({ request: makeReq(VALID_BODY) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; result: unknown };
    expect(json.ok).toBe(true);

    const reference = computeAmtIso({
      ...VALID_BODY,
      filingStatus: 'single',
      grantDate: new Date('2024-05-20'),
      terminationDate: null,
    } as AmtIsoInput);

    // Comparing via JSON normalizes Date → ISO string the same way the
    // endpoint serializes. The two payloads should be byte-identical.
    expect(JSON.stringify(json.result)).toEqual(JSON.stringify(reference));
  });

  it('defaults cashReturnRate to 0.04 when omitted (was previously required)', async () => {
    const { cashReturnRate, ...noRate } = VALID_BODY;
    void cashReturnRate;
    const res = await onRequest({ request: makeReq(noRate) });
    expect(res.status).toBe(200); // used to be a 400 "cashReturnRate required"
    const json = (await res.json()) as { ok: boolean; result: unknown };

    const referenceAt04 = computeAmtIso({
      ...noRate,
      cashReturnRate: 0.04,
      filingStatus: 'single',
      grantDate: new Date('2024-05-20'),
      terminationDate: null,
    } as AmtIsoInput);
    expect(JSON.stringify(json.result)).toEqual(JSON.stringify(referenceAt04));
  });

  // The website's verified case (web lib/calc/amtIso.math-verification.test.ts):
  // single, $250,000 taxable income, 10,000 ISOs at $5 against $50 FMV, Texas
  // (no state tax), horizon 1, growth 0, so year 1 is a $450,000 bargain element.
  // Regular federal tax on $250,000 is $56,456 either way; only Form 6251 line 2a moves.
  it('itemizedTaxes replaces the standard-deduction add-back in the federal AMT', async () => {
    const body = {
      shares: 10_000, strike: 5, fmv: 50, expectedGrowth: 0, volatilityDrag: 0,
      filingStatus: 'single', ordinaryIncome: 250_000, stateCode: 'TX',
      carryforwardCredit: 0, horizon: 1, cashReturnRate: 0,
      grantDate: '2025-04-30', hasLeftCompany: false, terminationDate: null,
    };
    type Year = { bargain: number; amti: number; regularFederal: number; amtOwedFederal: number };
    const year1 = async (b: object): Promise<Year> => {
      const res = await onRequest({ request: makeReq(b) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { result: { schedules: { lumpSum: { years: Year[] } } } };
      return json.result.schedules.lumpSum.years[0]!;
    };

    // Standard deduction: AMTI = 250,000 + 16,100 + 450,000 = 716,100 -> AMT 139,162.
    const standard = await year1(body);
    expect(standard.bargain).toBeCloseTo(450_000, 2);
    expect(standard.regularFederal).toBeCloseTo(56_456, 2);
    expect(standard.amti).toBeCloseTo(716_100, 2);
    expect(standard.amtOwedFederal).toBeCloseTo(139_162, 2);

    // Itemizer, $40,400 on Schedule A line 7: AMTI = 250,000 + 40,400 + 450,000 = 740,400 -> AMT 145,966.
    const itemized = await year1({ ...body, itemizedTaxes: 40_400 });
    expect(itemized.regularFederal).toBeCloseTo(56_456, 2);
    expect(itemized.amti).toBeCloseTo(740_400, 2);
    expect(itemized.amtOwedFederal).toBeCloseTo(145_966, 2);
  });

  it('returns 400 on missing required field', async () => {
    const bad = { ...VALID_BODY } as Partial<typeof VALID_BODY>;
    delete bad.shares;
    const res = await onRequest({ request: makeReq(bad) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/shares/);
  });

  it('returns 400 on invalid filingStatus', async () => {
    const res = await onRequest({
      request: makeReq({ ...VALID_BODY, filingStatus: 'married' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid grantDate', async () => {
    const res = await onRequest({
      request: makeReq({ ...VALID_BODY, grantDate: 'not-a-date' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/grantDate/);
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request('http://localhost/api/v1/amt-iso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await onRequest({ request: req });
    expect(res.status).toBe(400);
  });

  it('returns 405 on GET', async () => {
    const res = await onRequest({ request: makeReq({}, 'GET') });
    expect(res.status).toBe(405);
  });

  it('returns 204 on OPTIONS preflight with CORS headers', async () => {
    const res = await onRequest({ request: makeReq({}, 'OPTIONS') });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
  });
});
