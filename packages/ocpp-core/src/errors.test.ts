import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OcppError, ocppErrorFromZod, OcppTimeoutError } from "./errors.ts";
import { BootNotificationRequest, MeterValuesRequest } from "./schemas/charge-point.ts";

function codeFor(schema: z.ZodType, input: unknown): string {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error("expected a schema failure");
  }
  return ocppErrorFromZod(result.error, input).code;
}

describe("ocppErrorFromZod", () => {
  const boot = { chargePointVendor: "myenergi", chargePointModel: "Zappi" };

  it("maps a missing required property to OccurenceConstraintViolation", () => {
    expect(codeFor(BootNotificationRequest, { chargePointVendor: "myenergi" })).toBe(
      "OccurenceConstraintViolation",
    );
  });

  it("maps a wrong JSON type to TypeConstraintViolation", () => {
    expect(codeFor(BootNotificationRequest, { ...boot, chargePointModel: 7 })).toBe(
      "TypeConstraintViolation",
    );
  });

  it("maps an over-long string or a bad enum to PropertyConstraintViolation", () => {
    expect(codeFor(BootNotificationRequest, { ...boot, chargePointModel: "x".repeat(21) })).toBe(
      "PropertyConstraintViolation",
    );
    expect(codeFor(z.strictObject({ status: z.enum(["A"]) }), { status: "B" })).toBe(
      "PropertyConstraintViolation",
    );
    expect(codeFor(z.strictObject({ at: z.iso.datetime() }), { at: "yesterday" })).toBe(
      "PropertyConstraintViolation",
    );
    expect(codeFor(z.number().multipleOf(0.5), 0.3)).toBe("PropertyConstraintViolation");
    expect(codeFor(z.union([z.string(), z.number()]), true)).toBe("PropertyConstraintViolation");
    expect(
      codeFor(
        z.string().refine(() => false),
        "x",
      ),
    ).toBe("PropertyConstraintViolation");
  });

  it("maps unknown properties and a non-object payload to FormationViolation", () => {
    expect(codeFor(BootNotificationRequest, { ...boot, extra: true })).toBe("FormationViolation");
    expect(codeFor(BootNotificationRequest, "boot")).toBe("FormationViolation");
  });

  it("maps array cardinality to OccurenceConstraintViolation", () => {
    expect(codeFor(z.array(z.string()).min(1), [])).toBe("OccurenceConstraintViolation");
    expect(codeFor(z.array(z.string()).max(1), ["a", "b"])).toBe("OccurenceConstraintViolation");
  });

  it("reports the most structural problem first and lists every issue", () => {
    const input = { chargePointVendor: 5, chargePointModel: "x".repeat(30), extra: 1 };
    const result = BootNotificationRequest.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = ocppErrorFromZod(result.error, input);
      expect(error.code).toBe("FormationViolation");
      expect(error.message).toContain("chargePointVendor");
      expect(error.details).toMatchObject({ issues: expect.any(Array) as unknown });
    }
  });

  it("locates nested missing properties", () => {
    expect(
      codeFor(MeterValuesRequest, {
        connectorId: 1,
        meterValue: [{ timestamp: "2026-11-26T00:00:00Z" }],
      }),
    ).toBe("OccurenceConstraintViolation");
    expect(codeFor(MeterValuesRequest, { connectorId: 1, meterValue: [5] })).toBe(
      "TypeConstraintViolation",
    );
  });
});

describe("error classes", () => {
  it("carries the OCPP code and details", () => {
    const cause = new Error("db down");
    const error = new OcppError("InternalError", "failed", {
      details: { a: 1 },
      remote: true,
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "OcppError",
      code: "InternalError",
      details: { a: 1 },
      remote: true,
    });
    expect(error.cause).toBe(cause);
    expect(new OcppError("GenericError", "x")).toMatchObject({ details: {}, remote: false });
  });

  it("describes a timeout", () => {
    const error = new OcppTimeoutError("Reset", "m1", 30_000);
    expect(error.message).toBe("Reset (m1) got no reply within 30000 ms");
    expect(error).toMatchObject({ action: "Reset", messageId: "m1", timeoutMs: 30_000 });
  });
});
