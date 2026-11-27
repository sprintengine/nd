import type { Executor } from "@nd/db";
import type { FeeSettings } from "@nd/domain";

import type { Clock } from "./deps.ts";
import type { JobLogger, JobQueue } from "./jobs/jobs.ts";
import type { EmailSender } from "./senders/senders.ts";
import type { StripePayments } from "./stripe/payments.ts";
import type { Timings } from "./timings.ts";

/** What booking and payment logic needs, for route handlers and jobs alike. */
export interface Services {
  readonly db: Executor;
  readonly clock: Clock;
  readonly payments: StripePayments;
  readonly jobs: JobQueue;
  /** The platform fee and the card fee passed on to hosts: each charge's application fee. */
  readonly fees: FeeSettings;
  /** Years a deleted host's tax details are kept for platform reporting. */
  readonly taxRecordRetentionYears: number;
  readonly log: JobLogger;
  /** Booking and settlement durations; production keeps the defaults. */
  readonly timings: Timings;
  /** Email to drivers and hosts. */
  readonly email: EmailSender;
}
