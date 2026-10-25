import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Real MongoDB processes and Argon2 tests are resource intensive; bound worker contention.
    maxWorkers: 2,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/config/database.ts', 'src/shared/types/**'],
      reporter: ['text', 'html'],
    },
  },
});
