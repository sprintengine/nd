import type { Executor } from "@nd/db";

import type { Services } from "../src/services.ts";
import { fakePayments, memoryJobs } from "./fakes.ts";

/** Services over a database that is never touched (tests mock the data modules) and fakes. */
export function unitServices(now: Date, overrides: Partial<Services> = {}) {
  const payments = fakePayments();
  const jobs = memoryJobs();
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const clock = { current: now, now: () => clock.current };
  const db = {
    transaction: <T>(work: (tx: Executor) => Promise<T>) => work(db),
  } as unknown as Executor;
  const services: Services = {
    db,
    clock,
    payments: payments.payments,
    jobs: jobs.runner,
    platformFeeBps: 0,
    log,
    ...overrides,
  };
  return { services, payments, jobs, clock };
}
