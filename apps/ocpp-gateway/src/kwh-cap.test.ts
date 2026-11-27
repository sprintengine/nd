import { describe, expect, it, vi } from "vitest";

import { silentLogger } from "../test/silent-logger.ts";
import { kwhCapGuard } from "./kwh-cap.ts";
import type { KwhCapReached } from "./store.ts";

const reached: KwhCapReached = { transactionId: 42, deliveredKwh: 10.2, kwhCap: 10 };

function setup(answers: { ok: boolean; status?: string }[]) {
  const afterReply = new Map<string, () => void>();
  const call = vi.fn(() => {
    const answer = answers.shift() ?? { ok: true, status: "Accepted" };
    return Promise.resolve(
      answer.ok
        ? { ok: true, response: { status: answer.status } }
        : { ok: false, reason: "no_response", message: "no answer" },
    );
  });
  const kwhCapReached = vi.fn(() => Promise.resolve<KwhCapReached | undefined>(reached));
  const guard = kwhCapGuard({
    connection: {
      afterReply: (messageId: string, run: () => void) => afterReply.set(messageId, run),
      call: call as never,
    },
    store: { kwhCapReached },
    logger: silentLogger,
  });
  /** Handles MeterValues `messageId`, sends the reply, and lets the stop settle. */
  const meter = async (messageId: string) => {
    await guard.check("session-1", messageId);
    afterReply.get(messageId)?.();
    afterReply.delete(messageId);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { call, kwhCapReached, meter };
}

describe("kwhCapGuard", () => {
  it("does nothing below the cap", async () => {
    const { call, kwhCapReached, meter } = setup([]);
    kwhCapReached.mockResolvedValue(undefined);
    await meter("m-1");
    expect(call).not.toHaveBeenCalled();
  });

  it("stops the transaction once, after the reply, when the cap is reached", async () => {
    const { call, meter } = setup([]);
    await meter("m-1");
    await meter("m-2");
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("RemoteStopTransaction", { transactionId: 42 });
  });

  it("tries again on the next MeterValues after a rejected or unanswered stop", async () => {
    const { call, meter } = setup([{ ok: true, status: "Rejected" }, { ok: false }]);
    await meter("m-1");
    await meter("m-2");
    await meter("m-3");
    await meter("m-4");
    expect(call).toHaveBeenCalledTimes(3);
  });
});
