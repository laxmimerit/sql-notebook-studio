import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Modules that import 'vscode' get a small stub in tests.
    alias: { vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
