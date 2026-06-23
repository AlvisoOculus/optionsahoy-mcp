// AlphaLatitude Inc. (c) 2026
// Conversation-flow regression test for the Poe bot WITHOUT Poe: OpenRouter
// stands in for Poe's parsing model. Drives the REAL extractor prompt + the
// REAL handler/defaults/formatter for each flow, including multi-turn
// follow-ups, under-specified inputs, help, and off-topic. Run:
//   OPENROUTER_KEY=$(security find-generic-password -s openrouter-api-key -w) npx tsx scripts/poe-e2e-extract.mts
import { extractorPrompt, parseJsonObject, handleQuery } from '../functions/poe';

const KEY = process.env.OPENROUTER_KEY!;
const MODEL = process.env.OR_MODEL || 'openai/gpt-4o-mini';
const ctx = { request: new Request('http://x/poe', { method: 'POST' }), env: {} } as any;

type Turn = { role: 'user' | 'bot'; content: string };
type Case = { label: string; turns: Turn[]; expect: 'compute' | 'clarify' | 'help' | 'reject'; tool?: string };

const u = (content: string): Turn => ({ role: 'user', content });
const CASES: Case[] = [
  { label: 'amt complete', expect: 'compute', tool: 'amt_iso_optimize', turns: [u('10,000 ISOs, $2 strike, $40 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash, 12% growth. Best schedule?')] },
  { label: 'amt missing growth -> clarify', expect: 'clarify', turns: [u('10,000 ISOs, $2 strike, $40 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash. Best schedule?')] },
  { label: 'amt multi-turn (nvda follow-up)', expect: 'compute', tool: 'amt_iso_optimize', turns: [
    u('10,000 ISOs, $2 strike, $40 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash. Best schedule?'),
    { role: 'bot', content: 'Give me the stock ticker or an expected annual growth rate.' },
    u('nvda'),
  ] },
  { label: 'nso complete', expect: 'compute', tool: 'nso_calculate', turns: [u('Exercise and hold or sell 5,000 NSOs at $10 strike, $50 price, single, $180k income, CA, hold 2 years, ticker AAPL?')] },
  { label: 'rsu complete', expect: 'compute', tool: 'rsu_sell_vs_hold', turns: [u('1,000 RSUs vesting at $100, single, $200k income, CA, hold 2 years, ticker MSFT. Sell at vest or hold?')] },
  { label: 'concentration', expect: 'compute', tool: 'concentration_analyze', turns: [u('My NVDA position is $400k of my $1.2M, cost basis $100k, bought 2022-01-01, single, $200k income, CA. How risky?')] },
  { label: 'protective put', expect: 'compute', tool: 'protective_put_price', turns: [u('Hedge a $400k tech-software position at 10% protection for 1 year?')] },
  { label: 'qsbs', expect: 'compute', tool: 'qsbs_check', turns: [u('C-corp founder stock bought 2020-01-15 for $100k, selling 2026-06-01 for a $5M gain, original issuance, under $50M assets, tech, active business, single, $250k income, CA. QSBS?')] },
  { label: 'equity funding', expect: 'compute', tool: 'equity_funding_plan', turns: [u('Need $400k after tax by 2028-06-01 from 4,000 NVDA bought at $60 in 2023, now $140, 15% growth, MFJ, $280k income, CA. Plan?')] },
  { label: 'help general', expect: 'help', turns: [u('what can you do?')] },
  { label: 'help inputs', expect: 'help', turns: [u('can you describe what inputs you need?')] },
  { label: 'help specific', expect: 'help', turns: [u('how do I use the QSBS tool?')] },
  { label: 'off-topic', expect: 'reject', turns: [u('what is the weather today?')] },
];

function convoOf(turns: Turn[]): string {
  return turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n');
}

async function extract(conversation: string): Promise<any | null> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, temperature: 0, messages: [{ role: 'user', content: extractorPrompt(conversation) }] }),
  });
  const j: any = await r.json();
  return parseJsonObject(j?.choices?.[0]?.message?.content ?? '');
}

function classify(parsed: any, text: string): string {
  if (parsed?.help !== undefined) return 'help';
  if (parsed?.reject) return 'reject';
  if (/Almost there|I need a bit more|could not parse/.test(text)) return 'clarify';
  if (parsed?.clarify) return 'clarify';
  if (parsed?.tool && /not estimated|\*\*/.test(text)) return 'compute';
  return 'other';
}

let pass = 0;
for (const c of CASES) {
  const parsed = await extract(convoOf(c.turns));
  const res = await handleQuery(ctx, { type: 'query', query: c.turns }, async () => parsed);
  const text = JSON.parse((await res.text()).match(/event: text\ndata: (.*)/)?.[1] ?? '{"text":""}').text;
  const got = classify(parsed, text);
  const toolOk = c.tool ? parsed?.tool === c.tool : true;
  const ok = got === c.expect && toolOk;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label}  [expect ${c.expect}${c.tool ? '/' + c.tool : ''}, got ${got}${parsed?.tool ? '/' + parsed.tool : ''}]`);
  if (!ok) console.log('       text: ' + text.split('\n')[0].slice(0, 140));
}
console.log(`\n${pass}/${CASES.length} passed`);
