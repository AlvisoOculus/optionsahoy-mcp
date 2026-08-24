// AlphaLatitude Inc. © 2026
//
// Cloudflare Pages Functions run on workerd WITHOUT nodejs_compat: there is no
// `process` global, and a bare module-scope `process` reference doesn't fail
// the build — wrangler happily prints "Compiled Worker successfully" — it
// fails at PUBLISH time with "Uncaught ReferenceError: process is not
// defined", turning the whole deployment red with no local signal (PR #243's
// Cloudflare Pages check, root cause: lib/data/chains.ts read process.env at
// module scope and live-chain.ts started importing a value from it).
//
// This test reproduces the publish step locally: bundle each Functions route
// the way Pages does (esbuild, no Node shims) and EVALUATE the bundle with
// `process` shadowed to undefined. Module-scope code that dereferences a bare
// `process` throws here exactly as it does on workerd; the sanctioned
// `typeof process !== 'undefined'` guard (lib/data/data-base.ts) passes, since
// typeof on an undefined binding is 'undefined'.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const FUNCTIONS_DIR = join(__dirname, '..', 'functions');

/** Route files exactly as Pages sees them: every .ts under functions/, except
 *  underscore-prefixed directories/files (shared code, not routes). */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('Pages Functions evaluate without a process global', () => {
  const routes = routeFiles(FUNCTIONS_DIR);

  it('found the route files', () => {
    expect(routes.length).toBeGreaterThanOrEqual(3); // mcp, a2a, poe at minimum
  });

  it.each(routes.map((f) => [relative(FUNCTIONS_DIR, f), f]))(
    '%s',
    async (_name, file) => {
      const result = await build({
        entryPoints: [file],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser', // like workerd: no Node globals injected
        logLevel: 'silent',
      });
      const code = result.outputFiles[0].text;
      // Function parameters shadow globals: inside, `process` is an in-scope
      // binding holding undefined — same observable behavior as workerd for
      // both the bare deref (throws) and the typeof guard (passes).
      expect(() => new Function('process', code)(undefined)).not.toThrow();
    },
  );
});
