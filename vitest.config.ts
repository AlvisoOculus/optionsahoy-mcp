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
    // Blocks the network and seeds both market-data readers before every test.
    // See tests/setup-market-data.ts.
    setupFiles: ['tests/setup-market-data.ts'],
  },
});
