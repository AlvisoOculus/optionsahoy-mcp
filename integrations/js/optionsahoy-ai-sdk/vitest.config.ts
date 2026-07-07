// AlphaLatitude Inc. © 2026
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    root: __dirname,
  },
});
