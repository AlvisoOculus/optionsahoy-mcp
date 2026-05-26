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
  },
});
