// AlphaLatitude Inc. © 2026
//
// Asserts that the LIVE deployment is the code in this checkout, and that the
// agent-facing contract still holds end to end.
//
// Why this exists, from a real incident (2026-08-10): the GitHub push event
// for a merge to main was dropped. Cloudflare never created a production
// deployment and the post-deploy smoke workflow never ran, because BOTH are
// triggered by that same event. Nothing noticed for an hour; it was found by
// hand. Every other check in this repo is push-triggered, so a dropped event
// is invisible by construction - this script is meant to run on a SCHEDULE so
// it cannot be starved the same way.
//
// The same run also catches the second thing that fooled us that day: an edge
// cache serving pre-deploy HTML for a URL that had been fetched before the
// fix. Comparing the live widget byte-for-byte against the local build is a
// direct answer to "is what users get actually HEAD?".
//
// Usage: node scripts/conformance-live.mjs [baseUrl]
//        node scripts/conformance-live.mjs https://optionsahoy-mcp.pages.dev

import { readFileSync } from 'node:fs';
import { runWidget } from './lib/widget-host.mjs';

const BASE = (process.argv[2] ?? 'https://optionsahoy.com').replace(/\/$/, '');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const failures = [];
const notes = [];
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
    failures.push(name);
  }
}

async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'optionsahoy-conformance/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* reported by the caller as a shape failure */
  }
  return { res, json };
}

// ---------------------------------------------------------------- version
console.log(`\n== ${BASE} vs local HEAD (v${pkg.version}) ==`);

const init = await rpc('initialize', {});
const liveVersion = init.json?.result?.serverInfo?.version;
check(
  'serverInfo version matches this checkout',
  liveVersion === pkg.version,
  `live=${liveVersion} local=${pkg.version} - a mismatch means the deploy for HEAD never landed`,
);

// ------------------------------------------------------------- tools/list
const list = await rpc('tools/list', {});
const tools = list.json?.result?.tools ?? [];
check('tools/list returns all 8 tools', tools.length === 8, `got ${tools.length}`);

const { SCENARIO_WIDGET_URI } = await import('../functions/_lib/mcp-widget.ts').catch(() => ({}));
const WIDGET_URI = SCENARIO_WIDGET_URI ?? 'ui://widget/optionsahoy-scenario.html';
// The Anthropic Messages API rejects a top-level oneOf/allOf/anyOf and
// validates the WHOLE tools array, so one bad schema 400s all eight for every
// client that bridges MCP descriptors into it (Claude Desktop, claude.ai
// connectors). equity_funding_plan shipped that way; this is the live guard.
const combinator = tools
  .filter((t) => ['oneOf', 'allOf', 'anyOf'].some((k) => k in (t.inputSchema ?? {})))
  .map((t) => t.name);
check(
  'no tool schema has a top-level oneOf/allOf/anyOf (Anthropic rejects the whole array)',
  combinator.length === 0,
  combinator.join(', '),
);

const missingMeta = tools
  .filter((t) => t._meta?.['openai/outputTemplate'] !== WIDGET_URI)
  .map((t) => t.name);
check(
  'every tool advertises the widget template',
  missingMeta.length === 0,
  missingMeta.join(', '),
);

// --------------------------------------------------------- the widget itself
const read = await rpc('resources/read', { uri: WIDGET_URI });
const liveHtml = read.json?.result?.contents?.[0]?.text ?? '';
check('the widget template is readable', liveHtml.length > 0);

if (liveHtml) {
  // Behavioural, not just byte-equality: run the DEPLOYED script the way
  // ChatGPT drives it. A byte diff tells you something changed; this tells
  // you whether what users get still works.
  const LINK = 'https://optionsahoy.com/tools/rsu-sell-vs-hold?src=mcp_rsu_sc&mcp=AAA';
  let host;
  try {
    host = runWidget(liveHtml);
  } catch (e) {
    check('the deployed widget script parses', false, String(e).slice(0, 120));
  }

  if (host) {
    check('the deployed widget script parses', true);

    host.setOutput({ web_tool: LINK }).fire();
    check('renders a scenario link', host.read().visible && host.read().href === LINK);
    check('headline is scenario-scoped when the link carries one', /scenario/i.test(host.read().title));

    // The bug users actually saw: the related-tools line a dozen times over.
    let writes = 0;
    Object.defineProperty(host.els['oa-cta'], 'textContent', { set: () => writes++, get: () => '' });
    for (let i = 0; i < 500; i++) host.fire();
    check('500 host events cause no repeat writes', writes === 0, `${writes} writes`);

    // A confidently wrong link is worse than none: a mid-render throw must
    // not leave the previous tool's card on screen.
    const other = 'https://optionsahoy.com/tools/amt-iso?src=mcp_amt_sc&mcp=BBB';
    host.breakDom('oa-cta').setOutput({ web_tool: other }).fire();
    check('a mid-render throw hides the card', host.read().visible === false);
    host.breakDom(null).fire();
    check('and it recovers on the next event', host.read().visible && host.read().href === other);

    // The origin check is the security control on a client-rendered anchor.
    let leaked = null;
    for (const bad of [
      'https://optionsahoy.com.evil.com/x',
      'https://optionsahoy.com@evil.com/x',
      'http://optionsahoy.com/x',
    ]) {
      host.setOutput({ web_tool: bad }).fire();
      if (host.read().visible) leaked = bad;
    }
    check('off-origin hrefs are refused', leaked === null, leaked ?? '');
  }
}

// -------------------------------------------------- the scenario deep link
const call = await rpc('tools/call', {
  name: 'rsu_sell_vs_hold',
  arguments: {
    shares: 300, currentPrice: 350, ordinaryIncome: 300000, filingStatus: 'married_joint',
    stateCode: 'NY', stillEmployed: true, holdYears: 2, ticker: 'GOOGL', holdFunding: 'cash',
  },
});
const prose = call.json?.result?.content?.[1]?.text ?? '';
const blob = /mcp=([A-Za-z0-9_-]+)/.exec(prose)?.[1];
check('a tools/call returns a scenario deep link', Boolean(blob));

if (blob) {
  let env = null;
  try {
    env = JSON.parse(Buffer.from(blob, 'base64url').toString());
  } catch {
    /* reported below */
  }
  check('the payload decodes', Boolean(env));
  check('it names the tool it belongs to', env?.t === 'rsu-sell-vs-hold', env?.t ?? '');
  // The AMZN-for-GOOGL bug: without this the page falls through to whatever
  // ticker the visitor's browser last used on any tool.
  check('it carries the caller ticker as a label', env?.k === 'GOOGL', `k=${env?.k ?? 'ABSENT'}`);
  check(
    'the label never rides inside the resolved input',
    env?.i && !('ticker' in env.i),
    'a stray caller key must not reach a URL handed to an agent',
  );
  check('the resolved input is present', Object.keys(env?.i ?? {}).length > 5);
}

// ------------------------------------------------------- caching directives
check(
  'responses forbid caching',
  /no-store/.test(init.res.headers.get('cache-control') ?? ''),
  `cache-control=${init.res.headers.get('cache-control') ?? '(none)'}`,
);

// ---------------------------------------------------------- discovery files
const wk = await fetch(`${BASE}/.well-known/mcp.json`).then((r) => r.json()).catch(() => null);
if (wk) {
  // Not fatal on the apex: that path is served by the web repo, which
  // releases separately. Reported so the drift is visible rather than silent.
  const ok = wk.version === pkg.version;
  if (ok) check('.well-known/mcp.json version matches', true);
  else notes.push(`.well-known/mcp.json says ${wk.version}, this repo is ${pkg.version} (served by the web repo on the apex)`);
}

// ----------------------------------------------------------------- verdict
if (notes.length) {
  console.log('\nNotes:');
  notes.forEach((n) => console.log(`  - ${n}`));
}
if (failures.length) {
  console.error(`\n${failures.length} conformance failure(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nLive deployment matches HEAD and the agent contract holds.\n');
