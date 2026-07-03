// AlphaLatitude Inc. (c) 2026
// End-to-end test of the DEPLOYED Poe bot at optionsahoy.com/poe. Because
// extraction runs on our own model (not a Poe dependency), this hits the real
// production endpoint with no Poe session and no user points. Run:
//   POE_KEY=$(security find-generic-password -s poe -w) node scripts/poe-live-test.mjs
// Optional: POE_URL to point elsewhere (default https://optionsahoy.com/poe).

const URL = process.env.POE_URL || 'https://optionsahoy.com/poe';
const KEY = process.env.POE_KEY;
if (!KEY) { console.error('Set POE_KEY (the bot access key).'); process.exit(1); }

const u = (content) => ({ role: 'user', content });
const bot = (content) => ({ role: 'bot', content });

const CASES = [
  { label: 'amt complete', expect: /Exercise your|most money/, turns: [u('I have 20,000 ISOs at a $2 strike, $200 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash, 17% growth, 0.72 vol. Best schedule?')] },
  { label: 'amt missing growth -> ask', expect: /Almost there|growth rate/, turns: [u('I have 10,000 ISOs at a $2 strike, $40 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash. Best schedule?')] },
  { label: 'amt multi-turn (nvda)', expect: /Exercise your|most money/, turns: [u('10,000 ISOs, $2 strike, $40 value, MFJ, $300k income, CA, 4-year, granted 2022-01-01, 5% cash. Best schedule?'), bot('Give me a ticker or a growth rate.'), u('nvda')] },
  { label: 'nso', expect: /tax right now|wins by/, turns: [u('Exercise and hold or sell 5,000 NSOs at $10 strike, $50 price, single, $180k income, CA, hold 2 years, ticker AAPL?')] },
  { label: 'rsu', expect: /vesting shares|wins by/, turns: [u('1,000 RSUs vesting at $100, single, $200k income, CA, hold 2 years, ticker MSFT. Sell or hold?')] },
  { label: 'concentration', expect: /risk level|Downside/, turns: [u('My NVDA is $400k of my $1.2M, cost basis $100k, bought 2022-01-01, single, $200k income, CA. How risky?')] },
  { label: 'protective put', expect: /protect|collar/, turns: [u('Hedge a $400k tech-software position at 10% protection for 1 year?')] },
  { label: 'qsbs', expect: /QSBS|exclusion/, turns: [u('C-corp founder stock bought 2020-01-15 for $100k, selling 2026-06-01 for a $5M gain, original issuance, under $50M, tech, active, single, $250k income, CA. QSBS?')] },
  { label: 'equity funding', expect: /Recommended plan|aggressive/, turns: [u('Need $400k after tax by 2028-06-01 from 4,000 NVDA bought at $60 in 2023, now $140, 15% growth, MFJ, $280k income, CA. Plan?')] },
  { label: 'help', expect: /each calculator|what I can do/, turns: [u('what can you do?')] },
  { label: 'off-topic', expect: /not about equity[ -]compensation/, turns: [u('what is the weather today?')] },
];

async function chat(turns) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'user-agent': 'oa-live-test/1.0' },
    body: JSON.stringify({ type: 'query', query: turns, message_id: 'm-live', user_id: 'u-live', conversation_id: 'c-live' }),
  });
  for (const line of (await r.text()).split('\n')) {
    if (line.startsWith('data: ') && line.includes('"text"')) {
      try { return JSON.parse(line.slice(6)).text ?? ''; } catch { /* next */ }
    }
  }
  return '';
}

let pass = 0;
for (const c of CASES) {
  const text = await chat(c.turns);
  const ok = c.expect.test(text);
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label}`);
  if (!ok) console.log('       got: ' + text.split('\n')[0].slice(0, 160));
}
console.log(`\n${pass}/${CASES.length} passed against ${URL}`);
process.exit(pass === CASES.length ? 0 : 1);
