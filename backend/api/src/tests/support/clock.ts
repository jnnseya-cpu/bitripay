/**
 * Shifts the clock for a whole test run, so a fixture written against an absolute date fails here rather than in
 * six months on somebody else's afternoon.
 *
 * This exists because the same defect has now appeared three times in this repository: the open-banking income
 * window counted five or six salary months depending on the day; its CSV fixture then slid out of that window as
 * the calendar advanced; and an SLA review date written as 2027-01-31 reported itself overdue once the date passed.
 * Each one passed in CI the day it was written and broke weeks later with nobody having touched the code.
 *
 * Only `Date` and `Date.now` move. Timers are untouched, so nothing waits any longer than usual.
 * Used by `vitest.clock.config.ts`; run it with `npm run test:clock -w @bitripay/api`.
 */
const OFFSET_DAYS = Number(process.env.CLOCK_FORWARD_DAYS ?? 0);

if (OFFSET_DAYS) {
  const shift = OFFSET_DAYS * 86_400_000;
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      // No arguments means "now", which is the only case that has to move; every explicit date is left alone.
      // @ts-expect-error forwarding the real constructor's overloads
      super(...(args.length ? args : [RealDate.now() + shift]));
    }
    static now(): number {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
}
