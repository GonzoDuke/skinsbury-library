import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Minimal Vitest config — Node environment, mirror tsconfig's `@/*`
 * alias so test files can import from `@/lib/...` like the rest of
 * the codebase. No globals, no setup files; tests import vi/describe
 * /it/expect explicitly.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
