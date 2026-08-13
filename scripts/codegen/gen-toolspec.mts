// AlphaLatitude Inc. © 2026
//
// Generates public/toolspec.json (and the optionsahoy_web mirror when present)
// from the TOOLS source of truth, so the duplicated, hand-edited mirror cannot
// desync from the tool descriptions/schemas. The drift guard that runs in the
// test suite is tests/toolspec-generated.test.ts.
//
//   npm run gen:toolspec      # write the files
//   npm run verify:toolspec   # --check: exit 1 if any on-disk copy is stale
import { writeFileSync, readFileSync } from 'node:fs';
import { buildToolSpec } from '../../functions/_lib/mcp-tools';

const TARGETS = [
  'public/toolspec.json',
  '../optionsahoy_web/web/public/toolspec.json',
];

const spec = buildToolSpec();
const json = JSON.stringify(spec, null, 2) + '\n';
const check = process.argv.includes('--check');

const isAbsent = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

let stale = 0;
for (const path of TARGETS) {
  // Read directly and treat a missing file as "skip" - checking existsSync
  // first is a time-of-check/time-of-use race (js/file-system-race), and the
  // sibling web checkout being absent is a NORMAL outcome here rather than an
  // error worth a separate probe. Same idiom as gen-openapi.mts.
  let current: string;
  try {
    current = readFileSync(path, 'utf8');
  } catch (err) {
    if (isAbsent(err)) {
      console.log(`skip (absent): ${path}`);
      continue;
    }
    throw err;
  }
  // Compare parsed content (format-insensitive) so a re-minified copy that is
  // semantically identical is not flagged; --check still rewrites format drift.
  const same = JSON.stringify(JSON.parse(current)) === JSON.stringify(spec);
  if (check) {
    if (!same || current !== json) {
      console.error(`STALE: ${path} (run npm run gen:toolspec)`);
      stale++;
    } else {
      console.log(`ok: ${path}`);
    }
  } else {
    writeFileSync(path, json);
    console.log(`wrote: ${path}`);
  }
}
if (check && stale > 0) process.exit(1);
