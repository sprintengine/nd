import type { Executor } from "@nd/db";

import type { Clock } from "./deps.ts";
import type { JobLogger, JobQueue } from "./jobs/jobs.ts";
import type { EmailSender } from "./senders/senders.ts";
import type { StripePayments } from "./stripe/payments.ts";

/** What booking and payment logic needs, for route handlers and jobs alike. */
export interface Services {
  readonly db: Executor;
  readonly clock: Clock;
  readonly payments: StripePayments;
  readonly jobs: JobQueue;
  /** Platform fee in basis points, kept back from each transfer to the host. */
  readonly platformFeeBps: number;
  readonly log: JobLogger;
  /** Notices to drivers and hosts (session closed without a stop, payout summaries). */
  readonly email: EmailSender;
}
