// AlphaLatitude Inc. © 2026
//
// Drift guard (RSU-lot-order spec §2.4). Verifies the local
// equityFunding.ts / lotSelector.ts pair hashes to exactly what
// lib/calc/.mirror-manifest.json records. The manifest is checked into BOTH
// this repo and optionsahoy_web; because each repo runs this check against the
// SAME manifest, green in both proves the two files are byte-identical across
// repos — catching the partial-sync break that splitting equityFunding into
// equityFunding + lotSelector newly makes possible (copy one file, forget the
// other or forget to regenerate the manifest).
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
