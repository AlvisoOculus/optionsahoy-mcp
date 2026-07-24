// AlphaLatitude Inc. © 2026
//
// Drift guard (RSU-lot-order spec §2.4). Verifies the local
// equityFunding.ts / lotSelector.ts pair hashes to exactly what
// lib/calc/.mirror-manifest.json records.
//
// What this enforces: you cannot edit either file without regenerating the
// manifest — the hash mismatch turns this test red — so the manifest moves in
// lockstep with the pair in every PR that touches them, making the sync a
// conscious step: copy both files AND the manifest into optionsahoy_web together.
//
// What this does NOT do: prove cross-repo byte-identity on its own. It is a
// within-repo staleness check. If an edit here is never propagated to
// optionsahoy_web (both the file and the manifest left stale there), that repo
// stays internally green while the two drift. Catching that residual needs a
// real cross-repo assertion (a CI job fetching the other repo at a pinned ref
// and diffing the pair) — a follow-up; until then cross-repo identity rests on
// the sync PR touching both repos.
//
// If this fails after an intentional edit: regenerate the manifest in
// optionsahoy_web (node scripts/gen-calc-mirror-manifest.mjs), then copy
// equityFunding.ts, lotSelector.ts, AND .mirror-manifest.json into this repo
// in the same sync PR.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import manifest from '../lib/calc/.mirror-manifest.json';

const calcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'calc');

describe('lib/calc mirror drift guard', () => {
  for (const [file, expectedHash] of Object.entries(manifest.files)) {
    it(`${file} matches the mirror manifest`, () => {
      const actual = createHash('sha256')
        .update(readFileSync(join(calcDir, file)))
        .digest('hex');
      expect(actual).toBe(expectedHash);
    });
  }
});
