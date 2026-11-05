// AlphaLatitude Inc. © 2026
//
// Stamps package.json's version into every hand-maintained discovery file that
// advertises one, in THIS repo and in the optionsahoy_web mirror.
//
// Discovery files say "here is who I am and what version". They are read by
// registries, crawlers and agents deciding whether they already know this
// server, so a frozen version says "nothing changed here" through every
// release. They had drifted badly: mcp.json at 1.0.0 and both agent cards at
// 0.1.0 while the server reported 1.10.1 (fixed in #222), and the web repo's
// copy - the one served at optionsahoy.com/.well-known/mcp.json, which is what
// agents actually read - sat at 1.9.8 because it lives in a repo that releases
// separately and had no guard at all.
//
// Only version fields are touched: `version` in every file, and in the two
// MCP files `protocolVersion`, the newest protocol revision /mcp speaks (it
// sat at 2024-11-05 by hand until initialize began negotiating in 2026-11;
// the agent cards' protocolVersion is A2A's, a different protocol). These
// files are not mirrors of each other and legitimately differ elsewhere, so a
// whole-file copy would be wrong.
//
//   npm run gen:wellknown      # write
//   npm run verify:wellknown   # --check: exit 1 if any copy is stale
import { writeFileSync, readFileSync } from 'node:fs';
import { LATEST_PROTOCOL_VERSION } from '../../functions/_lib/version';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const MCP_FIELDS = { version, protocolVersion: LATEST_PROTOCOL_VERSION };
const TARGETS: Array<[path: string, fields: Record<string, string>]> = [
  ['public/.well-known/mcp.json', MCP_FIELDS],
  ['public/.well-known/agent-card.json', { version }],
  ['public/.well-known/agent.json', { version }],
  // Served at optionsahoy.com/.well-known/mcp.json - the copy agents read.
  ['../optionsahoy_web/web/public/.well-known/mcp.json', MCP_FIELDS],
];

const check = process.argv.includes('--check');
let stale = 0;

for (const [path, fields] of TARGETS) {
  // Read first and treat ENOENT as "absent", rather than existsSync-then-read.
  // The check-then-use form is a TOCTOU race (CodeQL js/file-system-race) and
  // is also one syscall more for no benefit: the sibling web checkout is
  // routinely missing, which is a normal outcome here, not an error.
  let current: string;
  try {
    current = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`skip (absent): ${path}`);
      continue;
    }
    throw err;
  }
  const parsed = JSON.parse(current) as Record<string, unknown>;
  const moved = Object.entries(fields).filter(([key, want]) => parsed[key] !== want);
  if (moved.length === 0) {
    console.log(`ok: ${path} (${Object.values(fields).join(', ')})`);
    continue;
  }
  const summary = moved.map(([key, want]) => `${key} ${parsed[key] ?? '(none)'} -> ${want}`).join(', ');
  if (check) {
    console.error(`STALE: ${path}: ${summary} (run npm run gen:wellknown)`);
    stale++;
    continue;
  }
  // Surgical: rewrite each string in place rather than re-serialising, so key
  // order, indentation and any comments-by-convention survive untouched. The
  // keys are the fixed names above, so they need no regex escaping.
  let next = current;
  for (const [key, want] of moved) {
    next = next.replace(new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`), `$1"${want}"`);
  }
  const stamped = JSON.parse(next) as Record<string, unknown>;
  const missed = moved.filter(([key, want]) => stamped[key] !== want).map(([key]) => key);
  if (missed.length > 0) {
    console.error(`FAILED to stamp ${path} - no top-level ${missed.join(', ')} field?`);
    process.exit(1);
  }
  writeFileSync(path, next);
  console.log(`wrote: ${path} (${summary})`);
}

if (check && stale > 0) process.exit(1);
