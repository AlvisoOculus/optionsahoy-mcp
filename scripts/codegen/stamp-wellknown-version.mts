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
// Only the `version` field is touched. These files are not mirrors of each
// other and legitimately differ elsewhere, so a whole-file copy would be wrong.
//
//   npm run gen:wellknown      # write
//   npm run verify:wellknown   # --check: exit 1 if any copy is stale
import { writeFileSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const TARGETS = [
  'public/.well-known/mcp.json',
  'public/.well-known/agent-card.json',
  'public/.well-known/agent.json',
  // Served at optionsahoy.com/.well-known/mcp.json - the copy agents read.
  '../optionsahoy_web/web/public/.well-known/mcp.json',
];

const check = process.argv.includes('--check');
let stale = 0;

for (const path of TARGETS) {
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
  const parsed = JSON.parse(current) as { version?: string };
  if (parsed.version === version) {
    console.log(`ok: ${path} (${version})`);
    continue;
  }
  if (check) {
    console.error(`STALE: ${path} says ${parsed.version ?? '(none)'}, package.json is ${version} (run npm run gen:wellknown)`);
    stale++;
    continue;
  }
  // Surgical: rewrite the version string in place rather than re-serialising,
  // so key order, indentation and any comments-by-convention survive untouched.
  const next = current.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (JSON.parse(next).version !== version) {
    console.error(`FAILED to stamp ${path} - no top-level "version" field?`);
    process.exit(1);
  }
  writeFileSync(path, next);
  console.log(`wrote: ${path} (${parsed.version ?? 'none'} -> ${version})`);
}

if (check && stale > 0) process.exit(1);
