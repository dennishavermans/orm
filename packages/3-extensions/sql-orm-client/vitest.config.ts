import { timeouts } from '@repo/test-utils';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    ...(process.env['CI'] ? { isolate: false } : {}),
    testTimeout: timeouts.typeScriptCompilation,
    hookTimeout: timeouts.default,
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
    },
  },
});
