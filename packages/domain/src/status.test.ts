import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  BOOKING_STATUSES,
  bookingStatusSchema,
  CANCELLED_BY,
  cancelledBySchema,
  CHARGER_STATUSES,
  chargerStatusSchema,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  CURRENCIES,
  currencyForCountry,
  currencySchema,
  DEVICE_PLATFORMS,
  devicePlatformSchema,
  DISPUTE_STATUSES,
  disputeStatusSchema,
  holdsSlot,
  HOST_COUNTRIES,
  HOST_PAYOUT_STATUSES,
  hostCountrySchema,
  hostPayoutStatusSchema,
  isOpenSession,
  OCPP_MESSAGE_DIRECTIONS,
  OCPP_MESSAGE_TYPES,
  ocppMessageDirectionSchema,
  ocppMessageTypeSchema,
  OPEN_SESSION_STATUSES,
  PAYMENT_STATUSES,
  paymentStatusSchema,
  SESSION_REVIEW_REASONS,
  SESSION_STATUSES,
  sessionReviewReasonSchema,
  sessionStatusSchema,
  SLOT_HOLDING_BOOKING_STATUSES,
  TERMINAL_BOOKING_STATUSES,
  TRANSFER_HOLD_REASONS,
  TRANSFER_STATUSES,
  transferHoldReasonSchema,
  transferStatusSchema,
} from "./index.ts";

const vocabularies: [string, readonly string[], z.ZodType][] = [
  ["booking status", BOOKING_STATUSES, bookingStatusSchema],
  ["session status", SESSION_STATUSES, sessionStatusSchema],
  ["session review reason", SESSION_REVIEW_REASONS, sessionReviewReasonSchema],
  ["charger status", CHARGER_STATUSES, chargerStatusSchema],
  ["connector type", CONNECTOR_TYPES, connectorTypeSchema],
  ["payment status", PAYMENT_STATUSES, paymentStatusSchema],
  ["transfer status", TRANSFER_STATUSES, transferStatusSchema],
  ["transfer hold reason", TRANSFER_HOLD_REASONS, transferHoldReasonSchema],
  ["host payout status", HOST_PAYOUT_STATUSES, hostPayoutStatusSchema],
  ["cancelled by", CANCELLED_BY, cancelledBySchema],
  ["dispute status", DISPUTE_STATUSES, disputeStatusSchema],
  ["OCPP message direction", OCPP_MESSAGE_DIRECTIONS, ocppMessageDirectionSchema],
  ["OCPP message type", OCPP_MESSAGE_TYPES, ocppMessageTypeSchema],
  ["device platform", DEVICE_PLATFORMS, devicePlatformSchema],
  ["currency", CURRENCIES, currencySchema],
  ["host country", HOST_COUNTRIES, hostCountrySchema],
];

describe("currencyForCountry", () => {
  it("prices Irish hosts in euro and UK hosts in sterling", () => {
    expect(currencyForCountry("IE")).toBe("EUR");
    expect(currencyForCountry("GB")).toBe("GBP");
  });
});

describe.each(vocabularies)("%s", (_name, values, schema) => {
  it("has unique values", () => {
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses values that are valid Postgres enum labels", () => {
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
  });

  it("accepts every listed value", () => {
    for (const value of values) {
      expect(schema.parse(value)).toBe(value);
    }
  });

  it.each(["", "unknown", 1, null, undefined])("rejects %j", (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe("booking statuses", () => {
  it("holds the slot only while the booking is confirmed, arrived or active", () => {
    expect(SLOT_HOLDING_BOOKING_STATUSES).toEqual(["confirmed", "arrived", "active"]);
    expect(BOOKING_STATUSES.filter(holdsSlot)).toEqual(SLOT_HOLDING_BOOKING_STATUSES);
  });

  it("keeps slot-holding and terminal statuses apart", () => {
    const terminal: readonly string[] = TERMINAL_BOOKING_STATUSES;
    expect(SLOT_HOLDING_BOOKING_STATUSES.some((status) => terminal.includes(status))).toBe(false);
  });
});

describe("session statuses", () => {
  it("treats only running transactions as open", () => {
    expect(SESSION_STATUSES.filter(isOpenSession)).toEqual(OPEN_SESSION_STATUSES);
    expect(isOpenSession("stopped")).toBe(false);
    expect(isOpenSession("charging")).toBe(true);
  });
});

describe("payment and transfer statuses", () => {
  it("model the separate charges and transfers flow", () => {
    expect(PAYMENT_STATUSES).toEqual(
      expect.arrayContaining(["pending_authorisation", "card_saved", "authorised", "captured"]),
    );
    expect(TRANSFER_STATUSES).toEqual(expect.arrayContaining(["pending", "held", "sent"]));
  });
});
