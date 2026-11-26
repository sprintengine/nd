import { releasableHeldTransfers } from "../data/settlement.ts";
import { createHostTransfer } from "../payments/settlement.ts";
import type { Services } from "../services.ts";
import { releaseHeldTransfersJob } from "./jobs.ts";

// Held transfers are retried when what held them clears: Stripe enables the
// host's payouts, or a review or a dispute is settled. (Saving tax details
// re-sends transfers held for them on its own.) createHostTransfer decides
// again, so a transfer still held for another reason stays held.

/** Most held transfers one run retries; a sweep picks up the rest. */
const RELEASE_BATCH = 100;

/** What a release run did. */
export interface ReleaseResult {
  readonly sent: number;
  readonly stillHeld: number;
}

/**
 * Retries every held transfer (or one host's) whose hold reason has cleared.
 * One that fails is logged and the rest go on; the run then throws so the job
 * is retried.
 */
export async function releaseHeldTransfers(
  services: Services,
  hostId?: string,
): Promise<ReleaseResult> {
  const candidates = await releasableHeldTransfers(services.db, {
    limit: RELEASE_BATCH,
    ...(hostId === undefined ? {} : { hostId }),
  });
  let sent = 0;
  let stillHeld = 0;
  let failed = 0;
  for (const { paymentId } of candidates) {
    try {
      const transfer = await createHostTransfer(services, paymentId);
      if (transfer.status === "sent") sent += 1;
      else stillHeld += 1;
    } catch (error) {
      failed += 1;
      services.log.error({ paymentId, err: error }, "held transfer could not be released");
    }
  }
  if (failed > 0) throw new Error(`${String(failed)} held transfers could not be released`);
  return { sent, stillHeld };
}

/**
 * Queues a release of held transfers (one host's, or every host's). Call it
 * when something that holds them may have cleared.
 */
export async function queueHeldTransferRelease(services: Services, hostId?: string): Promise<void> {
  await services.jobs.send(releaseHeldTransfersJob, hostId === undefined ? {} : { hostId }, {
    singletonKey: hostId ?? "all-hosts",
  });
}
