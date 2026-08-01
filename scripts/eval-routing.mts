// AlphaLatitude Inc. © 2026
//
// Tool-routing eval harness. Measures whether a calling model, given the
// OptionsAhoy MCP tool surface (tool definitions + server instructions),
// routes realistic user utterances to the right tool.
//
// Grades per case kind (never one blended aggregate — a blended score rewards
// a description set that suppresses calls):
//   single    — first tool_use name must equal `expected`
//   ambiguous — NO tool call AND the text asks a clarifying question that
//               mentions every `mustMention` term (silence alone is a FAIL)
//   negative  — no tool call
//   multi     — first tool_use name must be a member of `expectedSet`
//
// Usage:
//   npx tsx scripts/eval-routing.mts --label main --limit 20
//   npx tsx scripts/eval-routing.mts --toolspec /tmp/old-toolspec.json --mcp-src /tmp/old-mcp.ts --label pre-audit
//   npx tsx scripts/eval-routing.mts --compare scripts/eval/runs/A.json scripts/eval/runs/B.json
//
// A/B: extract the old surface with `git show <sha>:public/toolspec.json` and
// `git show <sha>:functions/mcp.ts`, pass via --toolspec/--mcp-src.
//
// Results: summary appended to scripts/eval/results.jsonl; per-case verdicts
// written to scripts/eval/runs/<ts>-<label>-<model>.json (input to --compare).
// Baselines are PER-MODEL — never compare rates across models or providers.
//
// Auth: ANTHROPIC_API_KEY env, else the macOS keychain item
// `anthropic-api-key` (same pattern as the ops benchmark runner), else the
// SDK's own resolution (`ant auth login` profile).
//
// NOT in CI: costs money and needs credentials. The CI-safe dataset drift
// guard lives in tests/eval-routing-cases.test.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS } from '../functions/_lib/mcp-tools';

// The claude.ai MCP-config key AND the tool-namespace prefix Claude Code builds
// from it (mcp__<key>__<tool>). Single source so the config writer and the
// parse regex can never disagree.
const MCP_SERVER_KEY = 'optionsahoy';
const CC_TOOL_RE = new RegExp(`^mcp__${MCP_SERVER_KEY}__(.+)$`);

// Canonical tool names, imported from the same source the dataset drift guard
// trusts (tests/eval-routing-cases.test.ts), so a rename/add can't silently
// desync the judge's vocabulary.
const TOOL_NAMES = TOOLS.map((t) => t.name);
const TOOL_NAME_RE = new RegExp(`\\b(${TOOL_NAMES.join('|')})\\b`);
// Short intents for the route judge. Guarded below to cover every TOOLS name.
const TOOL_INTENTS: Record<string, string> = {
  amt_iso_optimize: 'ISO exercise timing / AMT planning',
  nso_calculate: 'NSO exercise tax, sell-vs-hold at exercise',
  rsu_sell_vs_hold: 'RSU vest: sell at vest vs hold',
  concentration_analyze: 'single-stock concentration risk / diversify',
  protective_put_price: 'hedge pricing: protective put, collar, put spread',
  qsbs_check: 'QSBS / Section 1202 qualification',
  equity_funding_plan: 'which shares to sell and when to hit a cash goal',
  rsu_lot_optimize: 'which vested RSU lots to sell first, and in which years, to divest at the lowest tax',
};
for (const n of TOOL_NAMES) {
  if (!(n in TOOL_INTENTS)) throw new Error(`TOOL_INTENTS missing an entry for tool "${n}" (add it or the judge cannot route to it)`);
}

type Kind = 'single' | 'ambiguous' | 'negative' | 'multi' | 'input-discipline';
type EvalCase = {
  id: string;
  kind: Kind;
  utterance: string;
  expected: string | null;
  expectedSet?: string[];
  mustMention?: string[];
  /**
   * input-discipline only: fields the utterance does NOT supply and that no
   * ticker or sentinel can resolve for this scenario (the company is private
   * or uncovered). Passing a NUMBER for any of these is fabrication; asking
   * the user, or passing the documented "market" sentinel, is correct.
   */
  forbiddenArgs?: string[];
};
// route: how the model expressed its tool choice.
//   called  — emitted a tool_use block
//   implied — no call, but the reply is preparing the tool (asking for its
//             required fields), per the judge. This is CORRECT behavior under
//             STRICT_INPUT_NOTE when the utterance lacks required inputs —
//             the surface itself instructs "ask the user; do not invent".
//   none    — no call and no tool being prepared
type Verdict = {
  id: string;
  kind: Kind;
  pass: boolean;
  firstTool: string | null;
  route: 'called' | 'implied' | 'none';
  routedTool: string | null;
  /** input-discipline: the forbidden fields the model supplied a number for. */
  fabricated?: string[];
  note?: string;
};

// Sonnet 5 / Opus 4.7+ reject non-default sampling params (400); Haiku 4.5
// still accepts temperature, and 0 helps determinism there.
const TEMPERATURE_ZERO_OK = new Set(['claude-haiku-4-5']);
const MAX_TOKENS = 4096; // Sonnet 5 runs adaptive thinking by default; leave room.

// ---- CLI ----------------------------------------------------------------

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'compare' || key === 'dry' || key === 'help') out[key] = 'true';
      else out[key] = argv[++i] ?? '';
    } else pos.push(a);
  }
  return { out, pos };
}

const { out: args, pos: positional } = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    'Flags: --label <name> --models a,b --toolspec <path> --mcp-src <path> --cases <path> ' +
      '--kinds single,input-discipline --ids case-1,case-2 --limit N --trials N --concurrency N --dry | --compare <runA.json> <runB.json>\n' +
      '  --via-claude-code <armRepoPath>  Run through headless `claude -p` (subscription-billed)\n' +
      '    instead of the raw API. The arm repo supplies the stdio MCP server + instructions.\n' +
      '    Measures routing INSIDE the Claude Code harness (its system prompt is a confound);\n' +
      "    results carry provider 'claude-code' and must never be compared with raw-API runs.",
  );
  process.exit(0);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const CASES_PATH = args.cases ?? path.join(REPO, 'scripts/eval/routing-cases.json');
const TOOLSPEC_PATH = args.toolspec ?? path.join(REPO, 'public/toolspec.json');
const MCP_SRC_PATH = args['mcp-src'] ?? path.join(REPO, 'functions/mcp.ts');
const RESULTS_PATH = path.join(REPO, 'scripts/eval/results.jsonl');
const RUNS_DIR = path.join(REPO, 'scripts/eval/runs');
const VIA_CC = args['via-claude-code'] ? path.resolve(args['via-claude-code']) : null;
// Raw-API mode uses exact platform model IDs; claude -p mode uses the CLI's
// subscription aliases (sonnet = the claude.ai default tier, the surface that
// matters most for adoption).
const MODELS = (args.models ?? (VIA_CC ? 'sonnet,haiku' : 'claude-haiku-4-5,claude-sonnet-5'))
  .split(',')
  .map((s) => s.trim());
const LABEL = args.label ?? 'unlabeled';
// --kinds single,input-discipline : run only those case kinds. Keeps a targeted
// run (e.g. the 12 input-discipline cases) off the price of all 200.
const KINDS = args.kinds ? new Set(args.kinds.split(',').map((k) => k.trim())) : null;
// --ids a,b : run exactly these case ids. For re-testing a single regression
// after a description change without paying for the whole set.
const IDS = args.ids ? new Set(args.ids.split(',').map((k) => k.trim())) : null;
// `|| default` (not `?? default`): a flag passed with no value parses to '' ->
// Number('') === 0 -> falsy -> default, and a nonsensical 0 also falls back.
const TRIALS = Number(args.trials) || 1;
const CONCURRENCY = Number(args.concurrency) || (VIA_CC ? 3 : 4);
const PROVIDER = VIA_CC ? 'claude-code' : 'anthropic';

// Claude Code built-ins are removed so the only tools competing for selection
// are the MCP server's. (Its base system prompt remains — a known confound of
// this mode.)
const CC_DISALLOWED =
  'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task,TodoWrite,NotebookEdit,BashOutput,KillShell,ExitPlanMode,Agent,SlashCommand,Skill';
const CC_TIMEOUT_MS = 90_000;

// True when the arm's stdio server serves SERVER_INSTRUCTIONS on initialize
// (i.e. the arm postdates the instructions parity fix). Such an arm must not
// ALSO get --append-system-prompt, or the block is injected twice and the A/B
// stops being comparable against a pre-fix arm.
const ARM_SERVES_INSTRUCTIONS = VIA_CC
  ? fs.existsSync(path.join(VIA_CC, 'functions/_lib/mcp-instructions.ts'))
  : false;

// ---- Surface loading ----------------------------------------------------

function loadTools(toolspecPath: string) {
  const spec = JSON.parse(fs.readFileSync(toolspecPath, 'utf8')) as {
    tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  };
  const tools: Anthropic.Tool[] = spec.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  // Cache breakpoint on the last tool: tools render first, so this caches the
  // whole tool block. The system block below carries the second breakpoint.
  const last = tools[tools.length - 1] as Anthropic.Tool & { cache_control?: unknown };
  last.cache_control = { type: 'ephemeral' };
  return tools;
}

// The server instructions live as a single-quoted TS literal, now in the
// shared functions/_lib/mcp-instructions.ts (SERVER_INSTRUCTIONS) rather than
// inline in mcp.ts. Extract and unescape it so the eval system prompt mirrors
// what a real MCP client receives at initialize. The scrape survives the
// extraction because arm checkouts under --via-claude-code may predate it.
function loadInstructions(mcpSrcPath: string): string {
  // The literal now lives in functions/_lib/mcp-instructions.ts (shared with
  // the stdio server). Older arm checkouts still hold it inline in
  // functions/mcp.ts, so try the shared module first and fall back, and accept
  // either `SERVER_INSTRUCTIONS =` or the legacy `instructions:` form. That
  // keeps --via-claude-code A/B runs against pre-extraction arms working.
  const shared = path.join(path.dirname(mcpSrcPath), '_lib', 'mcp-instructions.ts');
  const srcPath = fs.existsSync(shared) ? shared : mcpSrcPath;
  const src = fs.readFileSync(srcPath, 'utf8');
  // Capture the literal, plus a trailing `+` if the literal is concatenated.
  const m = src.match(/(?:instructions:|SERVER_INSTRUCTIONS\s*=)\s*'((?:[^'\\]|\\.)*)'(\s*\+)?/);
  if (!m) throw new Error(`could not find instructions literal in ${srcPath}`);
  if (m[2]) {
    throw new Error(
      `instructions literal in ${srcPath} appears concatenated (found a trailing '+'); ` +
        'the regex would capture only the first chunk. Keep SERVER_INSTRUCTIONS a single literal.',
    );
  }
  // Single left-to-right pass: `\\` -> `\`, `\n` -> newline, `\'` -> `'`. A
  // multi-replace chain mis-decodes `\\n` (escaped backslash + n).
  return m[1]!.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

// ---- Grading ------------------------------------------------------------

// `routedTool` is firstTool when called, else the judge's classification of
// which tool the reply is preparing (null = none).
function grade(
  c: EvalCase,
  firstTool: string | null,
  routedTool: string | null,
  text: string,
  firstToolInput?: Record<string, unknown> | null,
): Verdict {
  const route: Verdict['route'] = firstTool ? 'called' : routedTool ? 'implied' : 'none';
  const base = { id: c.id, kind: c.kind, firstTool, route, routedTool };
  switch (c.kind) {
    case 'single':
      // Correct if the model called the right tool OR is preparing it (asking
      // for its inputs) — the latter is what STRICT_INPUT_NOTE mandates for
      // input-light utterances.
      return { ...base, pass: routedTool === c.expected };
    case 'multi':
      return { ...base, pass: routedTool !== null && (c.expectedSet ?? []).includes(routedTool) };
    case 'negative':
      // Stronger than "no call": preparing a tool for an out-of-scope ask
      // (route=implied) is also a routing failure.
      return { ...base, pass: routedTool === null };
    case 'input-discipline': {
      // The tools range-check but cannot provenance-check, so a fabricated
      // number is accepted silently and returns a confident wrong answer.
      // Correct behaviour is to ask for the field, or to use a documented
      // resolver. Anything numeric in `forbiddenArgs` is fabrication.
      //
      // Routing is NOT graded here: asking for the missing field is a pass
      // even though no tool was called, which is exactly the case the routing
      // kinds would score as an under-call.
      const args = firstToolInput ?? {};
      const fabricated = (c.forbiddenArgs ?? []).filter((f) => {
        const v = (args as Record<string, unknown>)[f];
        if (v === undefined || v === null) return false;
        // The "market" sentinel is a documented resolver, not a guess.
        if (typeof v === 'string') return v.trim().toLowerCase() !== 'market';
        return typeof v === 'number';
      });
      if (firstTool === null) return { ...base, pass: true, note: 'asked instead of calling' };
      return {
        ...base,
        pass: fabricated.length === 0,
        fabricated: fabricated.length ? fabricated : undefined,
        note: fabricated.length
          ? `fabricated ${fabricated.map((f) => `${f}=${JSON.stringify((args as Record<string, unknown>)[f])}`).join(', ')}`
          : 'called with no invented inputs',
      };
    }
    case 'ambiguous': {
      // A clarifying question must actually surface the distinction; a model
      // that silently under-calls must not score here.
      const lower = text.toLowerCase();
      const mentionsAll = (c.mustMention ?? []).every((t) => lower.includes(t.toLowerCase()));
      return {
        ...base,
        pass: firstTool === null && mentionsAll,
        note: firstTool === null && !mentionsAll ? 'no call but no clarifying mention' : undefined,
      };
    }
  }
}

// ---- Route judge --------------------------------------------------------
//
// When the model answers WITHOUT calling a tool, classify which tool (if any)
// the reply is preparing to use. Deterministic keyword matching can't do this
// reliably (models describe tools without naming them), so a cheap model
// judges. The judge sees only tool names + the reply — not the case's
// expectation — so it cannot leak the answer.

const JUDGE_TOOLS = TOOL_NAMES.map((n) => `${n} (${TOOL_INTENTS[n]})`).join(', ');

function judgePrompt(reply: string): string {
  return (
    'An assistant with access to these tools replied to a user without calling any tool yet:\n' +
    `TOOLS: ${JUDGE_TOOLS}\n\n` +
    `ASSISTANT REPLY:\n"""\n${reply.slice(0, 3000)}\n"""\n\n` +
    'Is the reply preparing to use one of these tools (e.g. gathering its inputs, saying it will ' +
    'run it)? If it is preparing SEVERAL, name the single one it is MOST preparing to use (the one ' +
    'it would run first). Answer with ONLY that tool name, or ONLY the word none if it is not ' +
    'preparing any of them.'
  );
}

function parseJudgeAnswer(answer: string): string | null {
  const m = answer.match(TOOL_NAME_RE);
  return m ? m[1]! : null;
}

// Spawn a headless `claude` with ANTHROPIC_API_KEY dropped (forces subscription
// auth). Shared by the router and judge callers so env/spawn setup can't drift.
function spawnClaude(cliArgs: string[]): ChildProcess {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return spawn('claude', cliArgs, { env });
}

function judgeViaClaudeCode(reply: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnClaude([
      '-p', judgePrompt(reply), '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--disallowedTools', CC_DISALLOWED,
    ]);
    let out = '';
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, CC_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', () => {
      try {
        done(parseJudgeAnswer((JSON.parse(out) as { result: string }).result));
      } catch {
        done(null);
      }
    });
    child.on('error', () => done(null));
  });
}

async function judgeViaApi(client: Anthropic, reply: string): Promise<string | null> {
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 64,
    temperature: 0,
    messages: [{ role: 'user', content: judgePrompt(reply) }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
  return parseJudgeAnswer(text);
}

// ---- Stats --------------------------------------------------------------

function rate(vs: Verdict[]): number {
  return vs.length === 0 ? 0 : vs.filter((v) => v.pass).length / vs.length;
}

// Percentile bootstrap over cases: resample the verdict list with replacement.
function bootstrapCI(vs: Verdict[], n = 1000): [number, number] {
  if (vs.length === 0) return [0, 0];
  const rates: number[] = [];
  // Deterministic mulberry32 so re-runs produce identical CIs for identical
  // verdicts. Uses Math.imul + |0 to stay in 32-bit; a plain LCG here
  // (seed * 1103515245) overflows MAX_SAFE_INTEGER and biases the resample.
  let seed = 12345;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    let pass = 0;
    for (let j = 0; j < vs.length; j++) if (vs[Math.floor(rand() * vs.length)]!.pass) pass++;
    rates.push(pass / vs.length);
  }
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(n * 0.025)]!, rates[Math.floor(n * 0.975)]!];
}

// ---- Compare mode (paired, per-case) ------------------------------------

function compareRuns(pathA: string, pathB: string): void {
  type Run = { label: string; model: string; casesVersion: string; verdicts: Verdict[] };
  const a = JSON.parse(fs.readFileSync(pathA, 'utf8')) as Run;
  const b = JSON.parse(fs.readFileSync(pathB, 'utf8')) as Run;
  if (a.model !== b.model) throw new Error(`model mismatch: ${a.model} vs ${b.model} — baselines are per-model`);
  if (a.casesVersion !== b.casesVersion) throw new Error(`casesVersion mismatch: ${a.casesVersion} vs ${b.casesVersion}`);
  // Compare only the case IDs present in BOTH runs — casesVersion pins the
  // dataset but not --limit, so a limited run vs a full run must not be
  // averaged over mismatched denominators.
  const byIdA = new Map(a.verdicts.map((v) => [v.id, v]));
  const idsB = new Set(b.verdicts.map((v) => v.id));
  const paired = a.verdicts.filter((v) => idsB.has(v.id));
  const aV = paired;
  const bV = b.verdicts.filter((v) => byIdA.has(v.id));
  const flips: { id: string; kind: Kind; direction: string; aTool: string | null; bTool: string | null }[] = [];
  let aOnly = 0;
  let bOnly = 0;
  for (const vb of bV) {
    const va = byIdA.get(vb.id)!;
    if (va.pass === vb.pass) continue;
    if (va.pass) aOnly++;
    else bOnly++;
    flips.push({
      id: vb.id,
      kind: vb.kind,
      direction: va.pass ? `${a.label} PASS -> ${b.label} FAIL` : `${a.label} FAIL -> ${b.label} PASS`,
      // routedTool, not firstTool: after the redesign a pass/fail commonly
      // routes via the implied path (firstTool null), so firstTool would print
      // "null -> null" exactly where routing changed.
      aTool: va.routedTool,
      bTool: vb.routedTool,
    });
  }
  // Exact two-sided sign test on the discordant pairs (McNemar).
  const nFlip = aOnly + bOnly;
  let p = 1;
  if (nFlip > 0) {
    const k = Math.min(aOnly, bOnly);
    let tail = 0;
    for (let i = 0; i <= k; i++) {
      let c = 1;
      for (let j = 0; j < i; j++) c = (c * (nFlip - j)) / (j + 1);
      tail += c / 2 ** nFlip;
    }
    p = Math.min(1, 2 * tail);
  }
  console.log(`model=${a.model} cases=${a.casesVersion} pairedN=${paired.length}`);
  for (const kind of ['single', 'ambiguous', 'negative', 'multi', 'input-discipline'] as Kind[]) {
    const ra = rate(aV.filter((v) => v.kind === kind));
    const rb = rate(bV.filter((v) => v.kind === kind));
    console.log(`  ${kind.padEnd(9)} ${a.label}=${(ra * 100).toFixed(1)}%  ${b.label}=${(rb * 100).toFixed(1)}%  delta=${((rb - ra) * 100).toFixed(1)}pp`);
  }
  console.log(`  flips: ${nFlip} (${b.label}-only wins=${bOnly}, ${a.label}-only wins=${aOnly}), sign-test p=${p.toFixed(3)}`);
  for (const f of flips) console.log(`    ${f.id} [${f.kind}] ${f.direction} (tool: ${f.aTool} -> ${f.bTool})`);
  if (nFlip === 0) console.log('  no per-case differences.');
}

// ---- Runner -------------------------------------------------------------

function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'anthropic-api-key', '-w'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined; // fall through to SDK profile resolution (ant auth login)
  }
}

// ---- claude -p mode -----------------------------------------------------
//
// Spawns headless Claude Code with ONLY the arm repo's stdio MCP server
// (--strict-mcp-config). Arms whose stdio server predates the instructions
// parity fix get those instructions appended to the system prompt instead;
// arms that serve them on initialize must NOT also get the flag, or the block
// lands in the prompt twice and the A/B is no longer comparable. Parses
// stream-json and kills the child after the FIRST
// assistant message: the routing decision is complete there, so tools never
// need to execute. env drops ANTHROPIC_API_KEY to force subscription auth
// (same idiom as the ops benchmark runner).

function ccMcpConfig(armPath: string): string {
  const tsxBin = path.join(armPath, 'node_modules/.bin/tsx');
  const server = path.join(armPath, 'src/stdio-server.ts');
  if (!fs.existsSync(tsxBin) || !fs.existsSync(server)) {
    throw new Error(`arm repo missing ${fs.existsSync(server) ? 'node_modules (run npm ci or symlink)' : 'src/stdio-server.ts'}: ${armPath}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-routing-'));
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command: tsxBin, args: [server] } } }));
  return cfg;
}

function callOnceViaClaudeCode(
  model: string,
  mcpConfigPath: string,
  instructions: string,
  utterance: string,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const child = spawnClaude([
      '-p', utterance,
      '--model', model,
      '--output-format', 'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config', mcpConfigPath,
      // Skip when the arm's stdio server already returns these on initialize
      // (see ARM_SERVES_INSTRUCTIONS) - otherwise they land in the prompt twice.
      ...(ARM_SERVES_INSTRUCTIONS ? [] : ['--append-system-prompt', instructions]),
      '--disallowedTools', CC_DISALLOWED,
      '--dangerously-skip-permissions',
    ]);
    let settled = false;
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      // error:true — a hang is a harness failure, NOT a valid "no tool" route.
      resolve({ firstTool: null, text: '', error: true });
    }, CC_TIMEOUT_MS);
    const finish = (result: CallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(result);
    };
    // stream-json emits one assistant event PER CONTENT BLOCK (thinking, text,
    // tool_use arrive as separate events). Accumulate text; stop at the first
    // tool_use (the routing decision) or at the final `result` event.
    const texts: string[] = [];
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === 'result') {
          finish({ firstTool: null, text: texts.join('\n') });
          return;
        }
        if (evt.type !== 'assistant' || !evt.message?.content) continue;
        for (const b of evt.message.content as { type: string; name?: string; text?: string; input?: Record<string, unknown> }[]) {
          if (b.type === 'text' && b.text) texts.push(b.text);
          if (b.type === 'tool_use') {
            const m = b.name?.match(CC_TOOL_RE);
            // Claude Code loads deferred MCP schemas via its own ToolSearch
            // tool first — that (and any other harness tool) is mechanics,
            // not the routing decision. Only an optionsahoy call ends the
            // case; stream on through everything else.
            if (m) {
              finish({ firstTool: m[1]!, firstToolInput: b.input ?? null, text: texts.join('\n') });
              return;
            }
          }
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on('close', () => {
      // Child ended before any assistant message (e.g. init failure) — a
      // harness error, not a valid route. Surface stderr for debugging.
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ firstTool: null, text: `(no assistant message; stderr: ${stderr.slice(0, 300)})`, error: true });
      }
    });
  });
}

async function callOnce(
  client: Anthropic,
  model: string,
  tools: Anthropic.Tool[],
  system: string,
  utterance: string,
): Promise<CallResult> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: MAX_TOKENS,
    tools,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: utterance }],
  };
  if (TEMPERATURE_ZERO_OK.has(model)) params.temperature = 0;
  const resp = await client.messages.create(params);
  if (resp.stop_reason === 'refusal') return { firstTool: null, text: '', usage: resp.usage };
  const firstToolBlock = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return {
    firstTool: firstToolBlock?.name ?? null,
    firstToolInput: (firstToolBlock?.input as Record<string, unknown> | undefined) ?? null,
    text,
    usage: resp.usage,
  };
}

type CallResult = {
  firstTool: string | null;
  /** Arguments of the first tool_use block. The routing kinds ignore this;
   *  input-discipline grades on it, which is why it must not be discarded. */
  firstToolInput?: Record<string, unknown> | null;
  text: string;
  usage?: Anthropic.Usage;
  error?: boolean;
};
type CallFn = (utterance: string) => Promise<CallResult>;
type JudgeFn = (reply: string) => Promise<string | null>;

async function runCase(
  call: CallFn,
  judge: JudgeFn,
  c: EvalCase,
  usageTotals: { in: number; out: number; cacheRead: number; cacheWrite: number },
): Promise<Verdict> {
  // --trials N: majority vote over independent calls (for close-call stability).
  const verdicts: Verdict[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const r = await call(c.utterance);
    if (r.usage) {
      usageTotals.in += r.usage.input_tokens;
      usageTotals.out += r.usage.output_tokens;
      usageTotals.cacheRead += r.usage.cache_read_input_tokens ?? 0;
      usageTotals.cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
    }
    if (r.error) {
      // A harness failure (timeout, init crash) is never a valid routing
      // outcome — fail the trial explicitly rather than letting a null route
      // count as a correct "no tool call" for negative cases.
      verdicts.push({ id: c.id, kind: c.kind, pass: false, firstTool: null, route: 'none', routedTool: null, note: 'harness-error' });
      continue;
    }
    // Route resolution: if no tool was called, ask the judge which tool the
    // reply is preparing (ambiguous cases skip it - their grading is textual;
    // input-discipline skips it too, since a no-call is already a pass there
    // and the judge call would be spend with no effect on the verdict).
    const skipJudge = c.kind === 'ambiguous' || c.kind === 'input-discipline';
    const routedTool = r.firstTool ?? (!skipJudge && r.text ? await judge(r.text) : null);
    verdicts.push(grade(c, r.firstTool, routedTool, r.text, r.firstToolInput));
  }
  const passMajority = verdicts.filter((v) => v.pass).length * 2 > verdicts.length;
  // Record a trial whose pass matches the majority, so the persisted
  // firstTool/route/routedTool (and the confusion matrix) can't contradict the
  // reported pass.
  const rep = verdicts.find((v) => v.pass === passMajority) ?? verdicts[0]!;
  return { ...rep, pass: passMajority };
}

async function main() {
  if (args.compare) {
    compareRuns(positional[0]!, positional[1]!);
    return;
  }

  const data = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as { casesVersion: string; cases: EvalCase[] };
  let cases = data.cases;
  // Kind filter first, so --limit N means N cases of the kinds you asked for.
  if (KINDS) {
    const unknown = [...KINDS].filter((k) => !cases.some((c) => c.kind === k));
    if (unknown.length) throw new Error(`--kinds names no case of kind: ${unknown.join(',')}`);
    cases = cases.filter((c) => KINDS.has(c.kind));
  }
  if (IDS) {
    const unknown = [...IDS].filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`--ids names no case: ${unknown.join(',')}`);
    cases = cases.filter((c) => IDS.has(c.id));
  }
  if (args.limit) cases = cases.slice(0, Number(args.limit));
  // In claude -p mode the arm repo supplies both the MCP server (tools) and
  // the instructions; the local --toolspec is unused.
  const mcpSrc = VIA_CC ? path.join(VIA_CC, 'functions/mcp.ts') : MCP_SRC_PATH;
  const tools = VIA_CC ? [] : loadTools(TOOLSPEC_PATH);
  const system = loadInstructions(mcpSrc);
  const mcpConfigPath = VIA_CC ? ccMcpConfig(VIA_CC) : null;
  const gitSha = execSync('git rev-parse --short HEAD', { cwd: VIA_CC ?? REPO, encoding: 'utf8' }).trim();

  console.log(
    `cases=${cases.length} (${data.casesVersion})  models=${MODELS.join(',')}  label=${LABEL}  trials=${TRIALS}  provider=${PROVIDER}\n` +
      (VIA_CC ? `arm=${VIA_CC} (sha ${gitSha})` : `toolspec=${TOOLSPEC_PATH}\nmcp-src=${MCP_SRC_PATH}`),
  );
  if (args.dry) return;

  const client = VIA_CC ? null : new Anthropic({ apiKey: resolveApiKey() });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  for (const model of MODELS) {
    const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    const verdicts: Verdict[] = [];
    const call: CallFn = VIA_CC
      ? (u) => callOnceViaClaudeCode(model, mcpConfigPath!, system, u)
      : (u) => callOnce(client!, model, tools, system, u);
    const judge: JudgeFn = VIA_CC ? judgeViaClaudeCode : (reply) => judgeViaApi(client!, reply);

    // Warm the prompt cache with one solo call: a cache entry only becomes
    // readable after the first response starts, so parallel cold calls would
    // all pay the full uncached prefix. (Also serves as a config smoke test
    // in claude -p mode before fanning out.)
    verdicts.push(await runCase(call, judge, cases[0]!, usage));

    // Then a small worker pool over the rest.
    let next = 1;
    const workers = Array.from({ length: Math.min(CONCURRENCY, cases.length - 1) }, async () => {
      while (next < cases.length) {
        const i = next++;
        verdicts.push(await runCase(call, judge, cases[i]!, usage));
        if (verdicts.length % 25 === 0) console.log(`  [${model}] ${verdicts.length}/${cases.length}`);
      }
    });
    await Promise.all(workers);

    // Per-kind report + confusion for tool-expecting kinds. calledRate splits
    // out how often the pass came from an actual tool_use vs an implied route.
    // rate/calledRate are null (not 0) when a kind has no cases (e.g. under
    // --limit) so a reader can't misread "untested" as "all failed".
    const perKind: Record<string, { n: number; rate: number | null; ci95: [number, number] | null; calledRate: number | null }> = {};
    for (const kind of ['single', 'ambiguous', 'negative', 'multi', 'input-discipline'] as Kind[]) {
      const vs = verdicts.filter((v) => v.kind === kind);
      perKind[kind] = vs.length
        ? {
            n: vs.length,
            rate: rate(vs),
            ci95: bootstrapCI(vs),
            calledRate: vs.filter((v) => v.route === 'called').length / vs.length,
          }
        : { n: 0, rate: null, ci95: null, calledRate: null };
    }
    const confusion: Record<string, Record<string, number>> = {};
    for (const v of verdicts) {
      if (v.kind !== 'single') continue;
      const expected = cases.find((c) => c.id === v.id)!.expected!;
      confusion[expected] ??= {};
      const actual = v.routedTool ?? '(none)';
      confusion[expected][actual] = (confusion[expected][actual] ?? 0) + 1;
    }

    console.log(`\n=== ${model} (${LABEL}) ===`);
    for (const [kind, s] of Object.entries(perKind)) {
      if (s.rate === null || s.ci95 === null) {
        console.log(`  ${kind.padEnd(9)} (no cases)`);
        continue;
      }
      console.log(
        `  ${kind.padEnd(9)} ${(s.rate * 100).toFixed(1)}%  (n=${s.n}, called ${((s.calledRate ?? 0) * 100).toFixed(0)}%, 95% CI ${(s.ci95[0] * 100).toFixed(1)}-${(s.ci95[1] * 100).toFixed(1)}%)`,
      );
    }
    console.log(
      `  tokens: in=${usage.in} out=${usage.out} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`,
    );

    const ts = new Date().toISOString();
    const runFile = path.join(RUNS_DIR, `${ts.replace(/[:.]/g, '-')}-${LABEL}-${model}.json`);
    fs.writeFileSync(
      runFile,
      JSON.stringify({ ts, gitSha, label: LABEL, model, provider: PROVIDER, casesVersion: data.casesVersion, verdicts }, null, 2),
    );
    fs.appendFileSync(
      RESULTS_PATH,
      JSON.stringify({ ts, gitSha, label: LABEL, model, provider: PROVIDER, casesVersion: data.casesVersion, nCases: cases.length, trials: TRIALS, perKind, confusion, usage, runFile: path.relative(REPO, runFile) }) + '\n',
    );
    console.log(`  verdicts: ${path.relative(REPO, runFile)}`);
  }
}

main().catch((err) => {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error(
      'Auth failed. Provide credentials via ANTHROPIC_API_KEY, the keychain item ' +
        `"anthropic-api-key" (security add-generic-password -s anthropic-api-key -a optionsahoy -w '<key>'), ` +
        'or `ant auth login`.',
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
