import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const namedExportsOnly = { selector: 'ExportDefaultDeclaration', message: 'Named exports only.' };
const noDynamicSharp = {
  selector: "ImportExpression > Literal[value='sharp']",
  message: 'sharp is imported only in image/pipeline.ts',
};
const noDynamicUndici = {
  selector: "ImportExpression > Literal[value='undici']",
  message: 'undici is imported only in source/fetcher.ts',
};
const noGlobalThisFetch = {
  selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
  message: 'fetch is called only in source/fetcher.ts',
};

export default defineConfig([
  {
    ignores: [
      '**/dist/**',
      '**/cdk.out/**',
      '**/node_modules/**',
      '**/coverage/**',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
      'eslint.config.js',
    ],
  },
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.tooling.json',
          './apps/*/tsconfig.json',
          './apps/*/tsconfig.test.json',
          './packages/*/tsconfig.json',
          './packages/*/tsconfig.test.json',
          './*/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-restricted-syntax': ['error', namedExportsOnly],
    },
  },
  {
    files: ['apps/api/src/**/*.ts', 'apps/api/test/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['sharp', 'undici'] }],
      'no-restricted-globals': ['error', 'fetch'],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'process.env is read only in config.ts' },
      ],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        namedExportsOnly,
        noDynamicSharp,
        noDynamicUndici,
        noGlobalThisFetch,
      ],
    },
  },
  {
    files: ['apps/api/src/**/*.test.ts', 'apps/api/test/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['undici'] }],
      'no-restricted-syntax': ['error', namedExportsOnly, noDynamicUndici, noGlobalThisFetch],
    },
  },
  {
    files: ['apps/api/src/image/pipeline.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['undici'] }],
      'no-restricted-syntax': ['error', namedExportsOnly, noDynamicUndici, noGlobalThisFetch],
    },
  },
  {
    files: ['apps/api/src/source/fetcher.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['sharp'] }],
      'no-restricted-globals': 'off',
      'no-restricted-syntax': ['error', namedExportsOnly, noDynamicSharp],
    },
  },
  {
    files: ['apps/api/src/config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['apps/api/src/observability/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/vitest.config.ts', '**/playwright.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
