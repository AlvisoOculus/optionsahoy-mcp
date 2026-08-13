// AlphaLatitude Inc. © 2026
//
// End-to-end smoke of src/stdio-server.ts through a REAL first-party client:
// headless Claude Code, pointed at the server over --mcp-config, with
// ANTHROPIC_API_KEY dropped so it uses subscription auth and costs nothing per
// run beyond normal usage.
//
// It fills a gap the rest of the suite has. conformance-live.mjs exercises the
// HTTP server at optionsahoy.com; the unit tests exercise the modules. NOTHING
// drove the stdio path end to end - and stdio is what Claude Desktop and every
// `npx` install actually run, so a break there is invisible to every other
// check while being the surface most users touch.
//
// WHAT THIS DOES NOT DO, stated because the temptation is to assume otherwise:
// it is NOT a schema-compatibility check. Claude Code sanitises or tolerates
// schema constructs the raw Messages API rejects - verified 2026-08-12 by
// restoring equity_funding_plan's top-level `anyOf` and watching all eight
// tools register anyway, is_error false. The guard for that class is the
// static tests/anthropic-schema-compat.test.ts, which runs in CI. This script
// answers a different question: can a real client load the server, see every
// tool, and successfully call one?
//
// Local only. GitHub Actions has no subscription auth, so this is not wired
// into a workflow - run it before releasing anything that touches the stdio
// server or the tool schemas.
//
// Usage: node scripts/stdio-client-smoke.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const SERVER = path.join(ROOT, 'src/stdio-server.ts');

for (const [label, p] of [['tsx', TSX], ['stdio-server.ts', SERVER]]) {
  if (!existsSync(p)) {
    console.error(`missing ${label}: ${p}${label === 'tsx' ? ' (run npm ci)' : ''}`);
    process.exit(1);
  }
}

// Wired into `npm run release:preflight`, which prepublishOnly runs - and
// `npm publish` runs in GitHub Actions on release, where there is no
// subscription auth and no `claude` binary. Skipping (exit 0) rather than
// failing is what makes it safe to gate a release on locally while remaining
// a no-op in CI. It protects the release that a human runs, which is the one
// where the stdio server can actually be broken by a local change.
if (process.env.CI) {
  console.log('CI detected - skipping the stdio smoke (needs local Claude Code subscription auth).');
  process.exit(0);
}
if (spawnSync('claude', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.log('`claude` CLI not available - skipping the stdio smoke.');
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), 'stdio-smoke-'));
const cfg = path.join(dir, 'mcp.json');
writeFileSync(cfg, JSON.stringify({ mcpServers: { optionsahoy: { command: TSX, args: [SERVER] } } }));
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// Subscription auth: dropping the key is what forces it, same idiom as
// scripts/eval-routing.mts so the two cannot drift.
// `allow` must name the MCP tools this prompt may invoke. Without it the run
// still reports is_error:false while the model sits waiting for a permission
// prompt that never comes in headless mode - which made the first version of
// the tool-call check pass without any tool ever running.
//
// stream-json rather than json for the same reason: the final result text
// cannot distinguish "called the tool and summarised it" from "described what
// it would call".
//
// And a tool_use event is NOT enough either - that only proves the model
// ATTEMPTED the call. Verified by mutation: with the permission grant removed
// the tool_use block still appears while the reply says "I need your
// permission", so a tool_use-only assertion passes with nothing executed.
// The proof of execution is a tool_result that came BACK from the server and
// is not an error.
function ask(prompt, { allow = [], timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const args = [
      '-p', prompt, '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--mcp-config', cfg,
      '--disallowedTools', 'Bash,Read,Write,Edit,WebFetch,WebSearch',
    ];
    if (allow.length) args.push('--allowedTools', allow.join(','));
    const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'ignore'] });

    let buf = '';
    const toolsUsed = [];
    const okResults = [];   // tool_use ids whose result returned without error
    let text = '';
    let isError = null;
    const idToName = {};
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, text, toolsUsed, reason: 'timed out' });
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      buf += c;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const byId = {};
        for (const block of ev?.message?.content ?? []) {
          if (block.type === 'tool_use' && block.name) {
            toolsUsed.push(block.name);
            byId[block.id] = block.name;
          }
          if (block.type === 'tool_result' && block.is_error !== true) okResults.push(block.tool_use_id);
        }
        Object.assign(idToName, byId);
        if (ev.type === 'result') {
          isError = ev.is_error;
          text = String(ev.result ?? '');
        }
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      const executed = okResults.map((id) => idToName[id]).filter(Boolean);
      resolve({
        ok: isError === false, text, toolsUsed, executed,
        reason: isError ? 'is_error' : isError === null ? 'no result event' : '',
      });
    });
  });
}

const EXPECTED = [
  'amt_iso_optimize', 'concentration_analyze', 'equity_funding_plan', 'nso_calculate',
  'protective_put_price', 'qsbs_check', 'rsu_lot_optimize', 'rsu_sell_vs_hold',
];

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures.push(name);
};

console.log('\n== stdio server through headless Claude Code ==');

const listed = await ask('Name the optionsahoy MCP tools you can see, comma separated. Do not call any.');
check('a real client loads the server', listed.ok, listed.reason || listed.text.slice(0, 120));
const missing = EXPECTED.filter((n) => !listed.text.includes(n));
check('all 8 tools register', listed.ok && missing.length === 0, `missing: ${missing.join(', ')}`);

// Registration is not use. A tool can appear and still fail on invocation -
// a bad schema, a handler throw, a serialisation problem.
const QSBS_TOOL = 'mcp__optionsahoy__qsbs_check';
const called = await ask(
  'Use the optionsahoy qsbs_check tool for: shares acquired 2020-03-01 at original issuance in a US C-corp, ' +
    'sold 2026-03-15, assets under 50m, tech-software, active business yes, basis 50000, gain 5000000, ' +
    'CA, ordinary income 300000, filing single. Reply with the qualification verdict in under 20 words.',
  { allow: [QSBS_TOOL] },
);
check('the run completes', called.ok, called.reason || called.text.slice(0, 140));
// Proof the SERVER ran it and returned a non-error result - not merely that
// the model asked to, which a blocked call also produces.
check(
  'the server executed the tool and returned a result',
  called.executed.includes(QSBS_TOOL),
  `attempted: ${called.toolsUsed.join(', ') || '(none)'}; executed: ${called.executed.join(', ') || '(none)'}`,
);
if (called.text) console.log(`        reply: ${called.text.replace(/\s+/g, ' ').slice(0, 150)}`);

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join('; ')}\n`);
  process.exit(1);
}
console.log('\nThe stdio server works through a real first-party client.\n');
