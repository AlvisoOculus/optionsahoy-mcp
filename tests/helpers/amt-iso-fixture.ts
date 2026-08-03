// AlphaLatitude Inc. © 2026
//
// Shared minimal valid /api/v1/amt-iso request body + builder, used by the
// endpoint contract test and the next_steps envelope test so the fixture
// can't drift between them.

export const VALID_AMT_ISO_BODY = {
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

export function makeAmtIsoReq(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/api/v1/amt-iso', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}
