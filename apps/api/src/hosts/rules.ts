import { randomInt } from "node:crypto";

import type { ChargerStatus, HostPayoutStatus } from "@nd/domain";

/** Models a host can choose when connecting a charger. */
export const CHARGER_MODELS = ["zappi", "zappi_glo"] as const;
export type ChargerModel = (typeof CHARGER_MODELS)[number];

/** Oldest Zappi firmware with the OCPP behaviour the platform relies on. */
export const MIN_FIRMWARE = "5.794";

/** Why a charger cannot be connected, or undefined when it can. */
export function eligibilityProblem(serial: string, model: ChargerModel): string | undefined {
  if (model === "zappi_glo" || serial.startsWith("2")) return undefined;
  if (serial.startsWith("1")) {
    return "This Zappi is a v2.0 (its serial number starts with 1). The v2.0 cannot connect over OCPP, so it cannot be listed.";
  }
  return "Only the Zappi v2.1 (serial number starting with 2) and the Zappi GLO can connect.";
}

/** The model name stored for a connected charger. */
export function storedModel(model: ChargerModel): string {
  return model === "zappi_glo" ? "zappi_glo" : "zappi_v2_1";
}

/** Whether a dotted firmware version (`5.794`) is at least `minimum`. Unknown counts as too old. */
export function firmwareAtLeast(version: string | null, minimum: string = MIN_FIRMWARE): boolean {
  if (version === null) return false;
  const parse = (text: string) => text.trim().split(".").map(Number);
  const actual = parse(version);
  const wanted = parse(minimum);
  if (actual.some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let i = 0; i < Math.max(actual.length, wanted.length); i++) {
    const a = actual[i] ?? 0;
    const w = wanted[i] ?? 0;
    if (a !== w) return a > w;
  }
  return true;
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALPHANUMERIC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A uniformly random string from `alphabet`, from the operating system's CSPRNG. */
export function randomString(length: number, alphabet: string = ALPHANUMERIC): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomInt(alphabet.length));
  return out;
}

/** Length of the OCPP Basic Auth password shown to the host once. */
export const CHARGER_SECRET_LENGTH = 20;

/** A new per-charger OCPP password. */
export function newChargerSecret(): string {
  return randomString(CHARGER_SECRET_LENGTH);
}

/** A new ChargeboxID: `ND` and 10 characters that are easy to read and type. */
export function newChargeboxId(): string {
  return `ND${randomString(10, UPPER_ALPHANUMERIC)}`;
}

/** One unmet condition for publishing a listing. */
export interface PublishBlocker {
  readonly code:
    "charger-not-online" | "firmware-too-old" | "payouts-not-enabled" | "no-availability";
  readonly message: string;
}

/** Everything that stops a charger being listed; empty when it can be. */
export function publishBlockers(input: {
  readonly status: ChargerStatus;
  readonly firmware: string | null;
  readonly payoutStatus: HostPayoutStatus;
  readonly availabilityCount: number;
}): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  if (input.status !== "online") {
    blockers.push({
      code: "charger-not-online",
      message:
        input.status === "onboarding"
          ? "The charger has not connected yet. Finish connecting it first."
          : "The charger is not online. Check its internet connection.",
    });
  }
  if (input.status !== "onboarding" && !firmwareAtLeast(input.firmware)) {
    blockers.push({
      code: "firmware-too-old",
      message: `Update the charger's firmware to ${MIN_FIRMWARE} or later.`,
    });
  }
  if (input.payoutStatus !== "enabled") {
    blockers.push({
      code: "payouts-not-enabled",
      message: "Finish setting up payouts with Stripe first.",
    });
  }
  if (input.availabilityCount === 0) {
    blockers.push({ code: "no-availability", message: "Add at least one availability window." });
  }
  return blockers;
}
