import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000',
      },
    },
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
    // Fork startup can exhaust constrained CI runners under the full suite,
    // leaving otherwise unrelated tests to time out before their workers run.
    // A bounded thread pool keeps parallel test execution without that churn.
    pool: 'threads',
    maxWorkers: 4,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: [
        'text',
        'json',
        'html',
        // Repo-relative paths, so diff-cover can match them to the git diff.
        ['lcov', { projectRoot: '..' }],
      ],
      thresholds: {
        statements: 56,
        branches: 53,
        functions: 50,
        lines: 58,
      },
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/__tests__/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
