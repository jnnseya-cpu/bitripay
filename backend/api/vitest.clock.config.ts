/**
 * The ordinary test configuration plus the clock shift in `src/tests/support/clock.ts`.
 *
 * Kept separate from `vitest.config.ts` so the normal run stays fast and honest about today, and a calendar check is
 * a deliberate command: `CLOCK_FORWARD_DAYS=400 npm run test:clock -w @bitripay/api`.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(base, defineConfig({ test: { setupFiles: ['./src/tests/support/clock.ts'] } }));
