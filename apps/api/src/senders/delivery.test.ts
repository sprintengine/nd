import { describe, expect, it } from "vitest";

import {
  AttemptError,
  DEFAULT_RETRY_POLICY,
  deliver,
  fetchFailure,
  isRetryableStatus,
  maskEmail,
  maskPhone,
  MessageDeliveryError,
} from "./delivery.ts";

describe("masking", () => {
  it("keeps the first letter and the domain of an address", () => {
    expect(maskEmail("aoife@example.com")).toBe("a***@example.com");
    expect(maskEmail("not-an-address")).toBe("***");
    expect(maskEmail("@example.com")).toBe("***");
  });

  it("keeps the last three digits of a number", () => {
    expect(maskPhone("+353 86 123 4567")).toBe("***567");
    expect(maskPhone("12")).toBe("***");
  });
});

describe("retry rules", () => {
  it("retries server errors and rate limits only", () => {
    expect([500, 502, 503, 429].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isRetryableStatus)).toBe(false);
  });

  it("classifies fetch failures", () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(fetchFailure(timeout)).toEqual({ reason: "timed out", retryable: true });
    expect(fetchFailure(new TypeError("fetch failed"))).toEqual({
      reason: "network error",
      retryable: true,
    });
    expect(fetchFailure("odd")).toMatchObject({ retryable: true });
    const classified = new AttemptError({ reason: "HTTP 400", retryable: false, status: 400 });
    expect(fetchFailure(classified)).toBe(classified.failure);
  });

  it("has sensible defaults", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ attempts: 3, baseDelayMs: 300, timeoutMs: 10_000 });
  });

  it("waits with the default sleep between attempts", async () => {
    let calls = 0;
    await deliver(
      { channel: "sms", provider: "Test", recipient: "+353861234567" },
      { attempts: 2, baseDelayMs: 1, timeoutMs: 1_000 },
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("first")) : Promise.resolve();
      },
      () => ({ reason: "flaky", retryable: true }),
    );
    expect(calls).toBe(2);
  });

  it("reports every attempt it made", async () => {
    const error = await deliver(
      { channel: "email", provider: "Test", recipient: "aoife@example.com" },
      { attempts: 0, baseDelayMs: 1, timeoutMs: 1 },
      () => Promise.resolve(),
      () => ({ reason: "never", retryable: true }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MessageDeliveryError);
    expect(error).toMatchObject({ attempts: 0, retryable: false });
  });
});
