// AlphaLatitude Inc. © 2026
//
// TIER 4, SCAFFOLD - the only check here that puts a real model in the loop.
//
// The problem it targets is the one the widget was built to route around:
// ChatGPT's model COMPOSES its reply from our tool output, so the scenario URL
// is regenerated rather than copied. Across eight observed runs it produced
// five different treatments of the same link - omitted entirely, whole,
// src-only, stripped to a bare path, and stripped to a path plus ChatGPT's own
// utm stamp. Escalating the prose instruction raised the odds and never fixed
// it, because the channel is lossy by construction.
//
// The widget is the verbatim path and tiers 1-3 cover it. This measures the
// PROSE fallback, which is what every non-widget client still receives, and
// turns "does the link survive the model" from an anecdote into a rate.
//
// STATUS: unexercised against the live API. It has never run with a real key,
// so treat the first green run as the thing that validates it, not as
// evidence about the model. The skip path below is the only part tested.
//
// Needs OPENAI_API_KEY. Without it this exits 0 and says so, so the workflow
// is harmless until the secret exists.
//
// Usage: node scripts/model-relay-live.mjs [runs]

const KEY = process.env.OPENAI_API_KEY;
const RUNS = Number(process.argv[2] ?? 3);
const MCP_URL = process.env.MCP_URL ?? 'https://optionsahoy.com/mcp';

if (!KEY) {
  console.log('OPENAI_API_KEY not set - skipping the model-relay check.');
  console.log('Add the secret to enable it; nothing else needs to change.');
  process.exit(0);
}

// One prompt that must route to rsu_sell_vs_hold and carries a ticker, so the
// reply should contain a scenario link with a ticker label in it.
const PROMPT =
  'I have 300 GOOGL RSUs vesting at $350. Married filing jointly, New York, ' +
  '$300k taxable income, still employed. Should I sell at vest or hold 2 years?';

async function once(i) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5',
      input: PROMPT,
      tools: [{ type: 'mcp', server_label: 'optionsahoy', server_url: MCP_URL, require_approval: 'never' }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = JSON.stringify(json);

  const calledTool = /rsu_sell_vs_hold/.test(text);
  // The whole question: did the payload survive the model's recomposition?
  const withPayload = /optionsahoy\.com\/tools\/rsu-sell-vs-hold\?[^"'\s]*mcp=[A-Za-z0-9_-]{20,}/.exec(text);
  const bareLink = /optionsahoy\.com\/tools\/[a-z-]+/.test(text);

  console.log(
    `  run ${i}: tool=${calledTool ? 'yes' : 'NO'} link=${withPayload ? 'with payload' : bareLink ? 'bare (payload stripped)' : 'none'}`,
  );
  return { calledTool, intact: Boolean(withPayload), bareLink };
}

console.log(`\n== model relay, ${RUNS} runs against ${MCP_URL} ==`);
const results = [];
for (let i = 1; i <= RUNS; i++) {
  try {
    results.push(await once(i));
  } catch (e) {
    console.log(`  run ${i}: ERROR ${String(e.message).slice(0, 160)}`);
    results.push({ calledTool: false, intact: false, bareLink: false, error: true });
  }
}

const routed = results.filter((r) => r.calledTool).length;
const intact = results.filter((r) => r.intact).length;
console.log(`\nrouted to the tool: ${routed}/${RUNS}`);
console.log(`link survived intact: ${intact}/${RUNS}`);

// Routing is a hard requirement - if the model stops calling the tool at all,
// something in our descriptions regressed and that IS our bug.
if (routed === 0) {
  console.error('\nFAIL: the model never called the tool. Check tool descriptions and routing instructions.');
  process.exit(1);
}
// Link survival is REPORTED, not enforced. It is the model's behaviour, not
// ours, and failing the build on it would make a red pipeline the normal
// state. The widget is the channel we actually control.
if (intact < RUNS) {
  console.log('\nNote: the prose link was mangled in at least one run. Expected - this is why the widget exists.');
}
console.log();
