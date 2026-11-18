import { defineConfig } from 'vitest/config';

// Browser-backed self-tests for the drift module. Kept out of the root
// config, whose baseline runs without a browser installed.
export default defineConfig({
  test: {
    include: ['drift/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
