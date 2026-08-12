// AlphaLatitude Inc. © 2026
//
// Measures the one thing nothing else does: after a tool returns, does the
// model reproduce our scenario link INTACT in its final answer?
//
// The gap this fills, precisely:
//   - scripts/eval-routing.mts already grades routing, but it inspects the
//     FIRST tool call and never feeds a result back, so it cannot see the
//     final prose.
//   - scripts/conformance-live.mjs proves the server EMITS a correct link.
//   - The widget is the verbatim path and is covered by the host emulator.
// Nobody was watching the prose channel, which is what every non-widget
// client still receives - and which is where the original problem lived:
// ChatGPT composed its reply FROM our output and regenerated the URL, giving
// five different treatments of the same link across eight runs.
//
// Runs a real loop against the LIVE server: tools/list -> model -> tool_call
// -> real tools/call -> feed the result back -> inspect the final text.
//
// HONEST LIMIT: this measures the MODEL, not ChatGPT-the-product. ChatGPT
// wraps the model in its own system prompt and post-processing, and that
// pipeline is where the mangling we actually observed came from. A clean
// result here does NOT prove ChatGPT behaves; a dirty one is still a real
// signal, and a drop across models points at our own output format.
//
// Auth: OPENROUTER_API_KEY (same convention as scripts/poe-model-bakeoff.mts).
// Without it this exits 0 and says so.
//
// Usage: node scripts/link-survival.mjs [runsPerModel]
//        OR_MODELS=openai/gpt-5,anthropic/claude-sonnet-4.6 node scripts/link-survival.mjs 2

const KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
const RUNS = Number(process.argv[2] ?? 2);
const MCP_URL = process.env.MCP_URL ?? 'https://optionsahoy.com/mcp';
const MODELS = (process.env.OR_MODELS ?? 'openai/gpt-5,anthropic/claude-sonnet-4.6').split(',');

if (!KEY) {
  console.log('OPENROUTER_API_KEY not set - skipping the link-survival check.');
  console.log('Add the secret to enable it; nothing else needs to change.');
  process.exit(0);
}

const PROMPT =
  'I have 300 GOOGL RSUs vesting at $350/share. Married filing jointly, New York, ' +
  '$300,000 taxable income, still employed. Should I sell at vest or hold 2 years?';

async function mcp(method, params) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'optionsahoy-link-survival/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json())?.result;
}

// MCP tool descriptors -> OpenAI-format function definitions.
const listed = (await mcp('tools/list', {}))?.tools ?? [];
if (!listed.length) {
  console.error(`No tools from ${MCP_URL} - cannot run.`);
  process.exit(1);
}
const TOOLS = listed.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

async function chat(model, messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://optionsahoy.com',
      'X-Title': 'OptionsAhoy link-survival check',
    },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto' }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const json = await res.json();
  const msg = json?.choices?.[0]?.message;
  if (!msg) throw new Error(`no message: ${JSON.stringify(json).slice(0, 180)}`);
  return msg;
}

// Anchored, and applied to EXTRACTED urls rather than searched inside the
// blob: an unanchored host match would count evil.com/?u=<our url> as
// survival (CodeQL js/regex/missing-regexp-anchor, which was a real bug here).
const PAYLOAD = /^https:\/\/optionsahoy\.com\/tools\/[a-z-]+\?[^"'\s]*mcp=[A-Za-z0-9_-]{20,}/;
const ANY_TOOL = /^https:\/\/optionsahoy\.com\/tools\/[a-z-]+/;
function classify(text) {
  const urls = text.match(/https:\/\/[^\s"'<>)\]]+/g) ?? [];
  if (urls.some((u) => PAYLOAD.test(u))) return 'intact';
  if (urls.some((u) => ANY_TOOL.test(u))) return 'stripped'; // link kept, payload lost
  return 'absent';
}

async function once(model) {
  const messages = [{ role: 'user', content: PROMPT }];
  let called = null;

  for (let turn = 0; turn < 4; turn++) {
    const msg = await chat(model, messages);
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (!calls.length) return { called, verdict: classify(msg.content ?? '') };

    for (const c of calls) {
      called ??= c.function?.name ?? null;
      let out;
      try {
        const args = JSON.parse(c.function?.arguments || '{}');
        const r = await mcp('tools/call', { name: c.function.name, arguments: args });
        out = r?.content?.map((b) => b.text).join('\n') ?? JSON.stringify(r);
      } catch (e) {
        out = `error: ${String(e.message).slice(0, 120)}`;
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, 12000) });
    }
  }
  return { called, verdict: 'no-final-answer' };
}

console.log(`\n== link survival, ${RUNS} run(s) x ${MODELS.length} model(s) against ${MCP_URL} ==`);
console.log('(measures the MODEL, not ChatGPT\'s own pipeline - see the header)\n');

const rows = [];
for (const model of MODELS) {
  const tally = { intact: 0, stripped: 0, absent: 0, other: 0, routed: 0 };
  for (let i = 1; i <= RUNS; i++) {
    try {
      const { called, verdict } = await once(model);
      if (called === 'rsu_sell_vs_hold') tally.routed++;
      tally[verdict] = (tally[verdict] ?? tally.other) + (verdict in tally ? 1 : 0);
      if (!(verdict in tally)) tally.other++;
      console.log(`  ${model} run ${i}: tool=${called ?? 'NONE'} link=${verdict}`);
    } catch (e) {
      tally.other++;
      console.log(`  ${model} run ${i}: ERROR ${String(e.message).slice(0, 140)}`);
    }
  }
  rows.push({ model, ...tally });
}

console.log('\nmodel                              routed  intact  stripped  absent');
for (const r of rows) {
  console.log(
    `${r.model.padEnd(34)} ${String(r.routed).padStart(6)} ${String(r.intact).padStart(7)} ` +
      `${String(r.stripped).padStart(9)} ${String(r.absent).padStart(7)}`,
  );
}

// Routing is OUR contract: if no model calls the tool, our descriptions
// regressed. Link survival is the model's behaviour and is reported only -
// failing on it would make red the normal state and teach us to ignore it.
const anyRouted = rows.some((r) => r.routed > 0);
if (!anyRouted) {
  console.error('\nFAIL: no model called the tool. Check tool descriptions and routing instructions.');
  process.exit(1);
}
const totalIntact = rows.reduce((n, r) => n + r.intact, 0);
if (totalIntact === 0) {
  console.log('\nNote: the payload survived in NO run. Expected on some models - this is why the widget exists.');
}
console.log();
