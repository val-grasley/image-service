import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'fake-upstream',
    include: ['src/**/*.test.ts'],
  },
});
