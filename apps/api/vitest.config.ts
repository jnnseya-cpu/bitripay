import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    env: { NODE_ENV: 'test', JWT_SECRET: 'test-jwt', APP_SECRET: 'test-app-secret' },
    fileParallelism: false,
  },
});
