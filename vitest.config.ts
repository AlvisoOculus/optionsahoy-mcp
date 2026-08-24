// AlphaLatitude Inc. © 2026
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@/lib': path.resolve(__dirname, 'lib'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Seeds the published implied-vol artifact before every test so nothing in
    // the suite reaches the network for it. See tests/setup-live-vols.ts.
    setupFiles: ['tests/setup-live-vols.ts'],
  },
});
