// AlphaLatitude Inc. © 2026
// Regenerates toolspec.json from the source-of-truth TOOLS array in
// functions/_lib/mcp-tools.ts, keeping every served copy in lockstep.
// Run: npx tsx scripts/gen-toolspec.ts
import { writeFileSync } from 'node:fs';
import { TOOLS } from '../functions/_lib/mcp-tools.ts';

const spec = {
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  })),
};

const json = JSON.stringify(spec);

const targets = [
  new URL('../public/toolspec.json', import.meta.url),
  new URL('../../optionsahoy_web/web/public/toolspec.json', import.meta.url),
  new URL('../../optionsahoy_web/web/out/toolspec.json', import.meta.url),
];

for (const target of targets) {
  writeFileSync(target, json);
  console.log(`wrote ${target.pathname} (${json.length} bytes)`);
}
