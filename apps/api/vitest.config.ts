import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@image-service/sdk': source('../../packages/sdk/src/index.ts'),
      '@image-service/fake-upstream/generator': source(
        '../../packages/fake-upstream/src/generator.ts',
      ),
      '@image-service/fake-upstream/server': source('../../packages/fake-upstream/src/server.ts'),
    },
  },
  test: {
    name: 'api',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
