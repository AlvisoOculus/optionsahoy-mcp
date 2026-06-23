// AlphaLatitude Inc. (c) 2026
// Local end-to-end test of the Poe bot's full pipeline WITHOUT Poe: uses
// OpenRouter as a stand-in for the Poe parsing model. Same extractor prompt,
// same JSON parsing, same handler + defaults + formatter. Run:
//   OPENROUTER_KEY=... npx tsx scripts/poe-e2e-extract.mts
import { extractorPrompt, parseJsonObject, handleQuery } from '../functions/poe';

const KEY = process.env.OPENROUTER_KEY!;
const MODEL = process.env.OR_MODEL || 'openai/gpt-4o-mini';
const ctx = { request: new Request('http://x/poe', { method: 'POST' }), env: {} } as any;

const CASES: Record<string, string> = {
  amt_iso_optimize:
    'I have 20,000 incentive stock options, $2 strike, $200 current value, married filing jointly, $300k income, California, 4-year horizon, granted 2022-01-01, 5.5% cash return, 17% expected growth, 0.72 volatility. Best exercise schedule?',
  nso_calculate:
    'Should I exercise and hold or sell 5,000 NSOs at $10 strike, current price $50, single, $180k income, California, hold 2 years, ticker AAPL?',
  rsu_sell_vs_hold:
    '1,000 RSUs vesting at $100, single, $200k income, CA, hold 2 years, MSFT. Sell at vest or hold?',
  concentration_analyze:
    'My NVDA position is worth $400k, cost basis $100k, bought 2022-01-01, tech software sector, single, $200k income, CA, total assets $1.2M. How concentrated am I?',
  protective_put_price:
    'How much would it cost to hedge a $400k tech software position at 10% downside protection for 1 year?',
  qsbs_check:
    'Founder C-corp stock bought 2020-01-15 for $100k basis, selling 2026-06-01 for $5M gain, original issuance, under $50M assets, tech software, active business, single, $250k income, CA. Do I qualify for QSBS?',
  equity_funding_plan:
    'I need $400k after tax by 2028-06-01. I have 4,000 NVDA shares, current $140, bought at $60 on 2023-06-15, 15% expected growth, 0.45 vol, married filing jointly, $280k income, CA, 4% cash interest, 10% shortfall tolerance.',
};

async function extract(question: string): Promise<any | null> {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [{ role: 'user', content: extractorPrompt(question) }],
    }),
  });
  const j: any = await resp.json();
  const content = j?.choices?.[0]?.message?.content ?? '';
  return parseJsonObject(content);
}

for (const [expectedTool, question] of Object.entries(CASES)) {
  const parsed = await extract(question);
  const routedTo = parsed?.tool ?? (parsed?.clarify ? 'CLARIFY' : parsed?.reject ? 'REJECT' : 'null');
  const res = await handleQuery(ctx, { type: 'query', query: [{ role: 'user', content: question }] }, async () => parsed);
  const text = JSON.parse((await res.text()).match(/event: text\ndata: (.*)/)?.[1] ?? '{"text":"<no text event>"}').text;
  const ok = routedTo === expectedTool && !/I need a bit more|could not parse/.test(text);
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${expectedTool}  (routed: ${routedTo})`);
  console.log(text.split('\n\n').slice(0, 4).join('\n'));
}
