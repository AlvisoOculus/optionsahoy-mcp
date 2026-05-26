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

const VALID_BODY = {
  shares: 5000,
  strike: 4,
  fmv: 90,
  expectedGrowth: 0.1,
  volatilityDrag: 0.2,
  filingStatus: 'single',
  ordinaryIncome: 250000,
  stateCode: 'CA',
  carryforwardCredit: 0,
  horizon: 4,
  cashReturnRate: 0.05,
  grantDate: '2024-05-20',
  hasLeftCompany: false,
  terminationDate: null,
};

function makeReq(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/api/v1/amt-iso', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

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
