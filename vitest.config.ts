import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/gpu-finops/tests/unit/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
