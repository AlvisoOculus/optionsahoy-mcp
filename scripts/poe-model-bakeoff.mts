// AlphaLatitude Inc. (c) 2026
// Extractor-model bake-off for the Poe bot. A/B-tests candidate OpenRouter
// models on the multi-turn carry-forward cases that broke in live use (P14:
// a follow-up "tweak" turn dropped the ticker / re-asked for growth, changing
// the answer), plus the happy-path cases. Picks no winner automatically --
// prints a comparison table so a human decides before changing DEFAULT_OR_MODEL.
//
// Run: OPENROUTER_API_KEY=... npx tsx scripts/poe-model-bakeoff.mts
import { extractorPrompt, parseJsonObject, handleQuery } from '../functions/poe';

const KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY!;
const MODELS = (process.env.OR_MODELS || [
  'openai/gpt-4o-mini',        // current default (baseline)
  'openai/gpt-4.1-mini',       // cheaper-tier upgrade, recent cutoff
  'openai/gpt-4o',             // full 4o, recent cutoff
  'anthropic/claude-3.5-haiku',// Claude small tier
].join(',')).split(',');

const ctx = { request: new Request('http://x/poe', { method: 'POST' }), env: {} } as any;
type Turn = { role: 'user' | 'bot'; content: string };

// Multi-turn AMZN flow that broke (P14): the tweak turn must keep the AMZN
// holding + compute, not clarify for growth, and apply riskToleranceShortfall.
const AMZN_T1 = 'Plan how to fund a cash goal from your equity by a deadline: after-tax cash goal is $400K and deadline is 07.2027, 2500 shares are AMZN (cost basis $16, purchase date 05.2014), filing status MFJ, state CA, income $200,000.';
const AMZN_BOT = 'Your sell schedule, 2,267 shares in total to net $400,000 after tax. Using AMZN at $233 as of the latest snapshot.';

type Case = {
  label: string;
  turns: Turn[];
  expect: 'compute' | 'clarify' | 'help' | 'reject';
  tool?: string;
  // optional extra checks on the extracted args
  argCheck?: (a: any) => { ok: boolean; note: string };
};

const u = (content: string): Turn => ({ role: 'user', content });
const b = (content: string): Turn => ({ role: 'bot', content });

const hasAmznStack = (a: any) => {
  const stacks = a?.args?.stacks;
  const tk = Array.isArray(stacks) ? stacks.map((s: any) => String(s?.ticker || '').toUpperCase()) : [];
  return tk.includes('AMZN');
};
const risk = (a: any) => a?.args?.riskToleranceShortfall;
const hasToday = (a: any) => a?.args?.today !== undefined;

const CASES: Case[] = [
  // --- the P14 regressions ---
  {
    label: 'AMZN tweak: "what about 2% shortfall risk?"',
    expect: 'compute', tool: 'equity_funding_plan',
    turns: [u(AMZN_T1), b(AMZN_BOT), u('what about 2% shortfall risk?')],
    argCheck: (a) => ({
      ok: hasAmznStack(a) && Math.abs((risk(a) ?? -1) - 0.02) < 1e-6,
      note: `amznKept=${hasAmznStack(a)} risk=${risk(a)} today=${hasToday(a)}`,
    }),
  },
  {
    label: 'AMZN tweak: "same as above" after a growth ask',
    expect: 'compute', tool: 'equity_funding_plan',
    turns: [u(AMZN_T1), b('What is the expected annual growth rate for your AMZN shares?'), u('same as above')],
    argCheck: (a) => ({ ok: hasAmznStack(a), note: `amznKept=${hasAmznStack(a)} today=${hasToday(a)}` }),
  },
  // --- happy-path sanity (must not regress) ---
  { label: 'equity funding (single turn)', expect: 'compute', tool: 'equity_funding_plan',
    turns: [u('Need $400k after tax by 2028-06-01 from 4,000 NVDA bought at $60 in 2023, now $140, 15% growth, MFJ, $280k income, CA. Plan?')],
    argCheck: (a) => ({ ok: !hasToday(a), note: `today=${hasToday(a)}` }) },
  { label: 'amt multi-turn (nvda follow-up)', expect: 'compute', tool: 'amt_iso_optimize',
    turns: [u('10,000 ISOs, $2 strike, $40 value, MFJ, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash. Best schedule?'), b('Give me the stock ticker or an expected annual growth rate.'), u('nvda')] },
  { label: 'qsbs', expect: 'compute', tool: 'qsbs_check',
    turns: [u('C-corp founder stock bought 2020-01-15 for $100k, selling 2026-06-01 for a $5M gain, original issuance, under $50M assets, tech, active business, single, $250k income, CA. QSBS?')] },
  { label: 'help', expect: 'help', turns: [u('what can you do?')] },
  { label: 'off-topic', expect: 'reject', turns: [u('what is the weather today?')] },
];

function convoOf(turns: Turn[]): string {
  return turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n');
}
async function extract(model: string, conversation: string): Promise<any | null> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: extractorPrompt(conversation) }] }),
  });
  const j: any = await r.json();
  if (j?.error) throw new Error(`${model}: ${j.error.message || JSON.stringify(j.error)}`);
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

const results: Record<string, { pass: number; total: number; lines: string[] }> = {};
for (const model of MODELS) {
  const r = { pass: 0, total: 0, lines: [] as string[] };
  for (const c of CASES) {
    r.total++;
    let parsed: any = null;
    try {
      parsed = await extract(model, convoOf(c.turns));
    } catch (e) {
      r.lines.push(`  ERR  ${c.label}: ${(e as Error).message}`);
      continue;
    }
    const res = await handleQuery(ctx, { type: 'query', query: c.turns }, async () => parsed);
    const text = JSON.parse((await res.text()).match(/event: text\ndata: (.*)/)?.[1] ?? '{"text":""}').text;
    const got = classify(parsed, text);
    const toolOk = c.tool ? parsed?.tool === c.tool : true;
    const ac = c.argCheck ? c.argCheck(parsed) : { ok: true, note: '' };
    const ok = got === c.expect && toolOk && ac.ok;
    if (ok) r.pass++;
    r.lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${c.label}  [exp ${c.expect}${c.tool ? '/' + c.tool : ''}, got ${got}${parsed?.tool ? '/' + parsed.tool : ''}]${ac.note ? '  ' + ac.note : ''}`);
  }
  results[model] = r;
}

console.log('\n================ EXTRACTOR MODEL BAKE-OFF ================');
for (const model of MODELS) {
  const r = results[model];
  console.log(`\n### ${model}  ->  ${r.pass}/${r.total}`);
  r.lines.forEach((l) => console.log(l));
}
console.log('\n================ SUMMARY ================');
for (const model of MODELS) console.log(`${results[model].pass}/${results[model].total}  ${model}`);
