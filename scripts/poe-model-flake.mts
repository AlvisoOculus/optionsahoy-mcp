// AlphaLatitude Inc. (c) 2026
// Flakiness probe for the Poe extractor: repeats the two multi-turn "tweak"
// cases that broke in live use (P14) N times per model at the production
// temperature (0) and reports the pass rate. Measures the reliability the
// prompt fix already buys vs. what a model upgrade adds.
// Run: OPENROUTER_API_KEY=... OR_N=8 npx tsx scripts/poe-model-flake.mts
import { extractorPrompt, parseJsonObject } from '../functions/poe';

const KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY!;
const N = Number(process.env.OR_N || 8);
const MODELS = (process.env.OR_MODELS || 'openai/gpt-4o-mini,openai/gpt-4.1-mini,openai/gpt-4o').split(',');

const AMZN_T1 = 'Plan how to fund a cash goal from your equity by a deadline: after-tax cash goal is $400K and deadline is 07.2027, 2500 shares are AMZN (cost basis $16, purchase date 05.2014), filing status MFJ, state CA, income $200,000.';
const AMZN_BOT = 'Your sell schedule, 2,267 shares in total to net $400,000 after tax. Using AMZN at $233 as of the latest snapshot.';

const CASES = [
  {
    label: '2% shortfall tweak',
    convo: `User: ${AMZN_T1}\nAssistant: ${AMZN_BOT}\nUser: what about 2% shortfall risk?`,
    ok: (a: any) => a?.tool === 'equity_funding_plan'
      && Array.isArray(a?.args?.stacks) && a.args.stacks.some((s: any) => String(s?.ticker || '').toUpperCase() === 'AMZN')
      && Math.abs((a?.args?.riskToleranceShortfall ?? -1) - 0.02) < 1e-6,
  },
  {
    label: '"same as above" tweak',
    convo: `User: ${AMZN_T1}\nAssistant: What is the expected annual growth rate for your AMZN shares?\nUser: same as above`,
    ok: (a: any) => a?.tool === 'equity_funding_plan'
      && Array.isArray(a?.args?.stacks) && a.args.stacks.some((s: any) => String(s?.ticker || '').toUpperCase() === 'AMZN'),
  },
];

async function extract(model: string, conversation: string): Promise<any | null> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: extractorPrompt(conversation) }] }),
  });
  const j: any = await r.json();
  if (j?.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return parseJsonObject(j?.choices?.[0]?.message?.content ?? '');
}

console.log(`\n=== FLAKINESS PROBE (N=${N} per case, temperature 0) ===`);
for (const model of MODELS) {
  const counts: string[] = [];
  for (const c of CASES) {
    let pass = 0;
    for (let i = 0; i < N; i++) {
      try { if (c.ok(await extract(model, c.convo))) pass++; } catch (e) { /* count as fail */ }
    }
    counts.push(`${c.label}: ${pass}/${N}`);
  }
  console.log(`${model}\n   ${counts.join('   |   ')}`);
}
