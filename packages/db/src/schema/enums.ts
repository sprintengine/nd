import {
  BOOKING_STATUSES,
  CANCELLED_BY,
  CHARGER_STATUSES,
  CONNECTOR_TYPES,
  CURRENCIES,
  DEVICE_PLATFORMS,
  DISPUTE_STATUSES,
  HOST_PAYOUT_STATUSES,
  OCPP_MESSAGE_DIRECTIONS,
  OCPP_MESSAGE_TYPES,
  PAYMENT_STATUSES,
  SESSION_STATUSES,
  TRANSFER_HOLD_REASONS,
  TRANSFER_STATUSES,
} from "@nd/domain";
import { pgEnum } from "drizzle-orm/pg-core";

// Postgres enums built from the @nd/domain vocabularies. Adding a value to a
// domain list needs a new migration (`pnpm --filter @nd/db db:generate`).

export const bookingStatus = pgEnum("booking_status", BOOKING_STATUSES);
export const sessionStatus = pgEnum("session_status", SESSION_STATUSES);
export const chargerStatus = pgEnum("charger_status", CHARGER_STATUSES);
export const connectorType = pgEnum("connector_type", CONNECTOR_TYPES);
export const paymentStatus = pgEnum("payment_status", PAYMENT_STATUSES);
export const transferStatus = pgEnum("transfer_status", TRANSFER_STATUSES);
export const transferHoldReason = pgEnum("transfer_hold_reason", TRANSFER_HOLD_REASONS);
export const hostPayoutStatus = pgEnum("host_payout_status", HOST_PAYOUT_STATUSES);
export const cancelledBy = pgEnum("cancelled_by", CANCELLED_BY);
export const disputeStatus = pgEnum("dispute_status", DISPUTE_STATUSES);
export const ocppMessageDirection = pgEnum("ocpp_message_direction", OCPP_MESSAGE_DIRECTIONS);
export const ocppMessageType = pgEnum("ocpp_message_type", OCPP_MESSAGE_TYPES);
export const devicePlatform = pgEnum("device_platform", DEVICE_PLATFORMS);
export const currency = pgEnum("currency", CURRENCIES);
