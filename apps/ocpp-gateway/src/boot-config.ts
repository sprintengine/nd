import type { ControlResult } from "@nd/domain";
import type {
  ChangeConfigurationResponse,
  GetConfigurationResponse,
  OcppRequest,
  OcppResponse,
} from "@nd/ocpp-core";

import type { Logger } from "./logger.ts";
import type { GatewayStore } from "./store.ts";

/** Heartbeat interval, in seconds, given in BootNotification.conf and pushed as HeartbeatInterval. */
export const HEARTBEAT_INTERVAL_SECONDS = 300;

/**
 * The configuration every charger gets on boot: locked until we start it,
 * every tag checked with us, fast charging and a meter sample every minute.
 */
export function bootConfiguration(
  heartbeatIntervalSeconds: number = HEARTBEAT_INTERVAL_SECONDS,
): readonly (readonly [key: string, value: string])[] {
  return [
    ["FreeCharging", "false"],
    ["LocalAuthListEnabled", "false"],
    ["StopTransactionOnInvalidId", "true"],
    // Case-sensitive on a Zappi.
    ["OCPPChargeMode", "Fast"],
    ["MeterValueSampleInterval", "60"],
    ["HeartbeatInterval", String(heartbeatIntervalSeconds)],
  ];
}

/** At most this many ChangeConfiguration writes per charger per window, to spare its flash. */
export const CONFIG_WRITE_LIMIT = 24;
export const CONFIG_WRITE_WINDOW_MS = 60 * 60 * 1000;

function sameValue(current: string, desired: string): boolean {
  if (/^(true|false)$/i.test(desired)) {
    return current.toLowerCase() === desired.toLowerCase();
  }
  if (/^-?\d+$/.test(desired)) {
    return current.trim() !== "" && Number(current) === Number(desired);
  }
  return current === desired;
}

/** The keys whose current value differs from the desired one (or is unknown), in order. */
export function configDifferences(
  current: Readonly<Record<string, string>>,
  desired: readonly (readonly [string, string])[],
): { key: string; value: string }[] {
  return desired
    .filter(([key, value]) => {
      const existing = current[key];
      return existing === undefined || !sameValue(existing, value);
    })
    .map(([key, value]) => ({ key, value }));
}

/** A GetConfiguration answer as a key-to-value record (keys without a value are left out). */
export function configToRecord(response: GetConfigurationResponse): Record<string, string> {
  const config: Record<string, string> = {};
  for (const { key, value } of response.configurationKey ?? []) {
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}

/** The part of a charger connection configuration needs. */
export interface ConfigTarget {
  readonly charger: { readonly id: string };
  call<A extends "ChangeConfiguration" | "GetConfiguration">(
    action: A,
    request: OcppRequest<A>,
  ): Promise<ControlResult<OcppResponse<A>>>;
}

/**
 * Guards ChangeConfiguration writes: at most {@link CONFIG_WRITE_LIMIT} per
 * charger in any rolling window. Counted from the outbound CALLs in
 * `ocpp_messages`, so the budget survives reconnects and restarts. Writes to
 * one charger are serialised, so two writers cannot both take the last slot.
 */
export class ConfigWriteBudget {
  readonly #store: GatewayStore;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => Date;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    store: GatewayStore,
    options: { limit?: number; windowMs?: number; now?: () => Date } = {},
  ) {
    this.#store = store;
    this.#limit = options.limit ?? CONFIG_WRITE_LIMIT;
    this.#windowMs = options.windowMs ?? CONFIG_WRITE_WINDOW_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /** Writes one key if the budget allows; otherwise answers `budget_exhausted` without sending. */
  write(
    target: ConfigTarget,
    key: string,
    value: string,
  ): Promise<ControlResult<ChangeConfigurationResponse>> {
    const chargerId = target.charger.id;
    const previous = this.#locks.get(chargerId) ?? Promise.resolve();
    const result = previous.then(async (): Promise<ControlResult<ChangeConfigurationResponse>> => {
      const since = new Date(this.#now().getTime() - this.#windowMs);
      const used = await this.#store.countOutboundCalls(chargerId, "ChangeConfiguration", since);
      if (used >= this.#limit) {
        return {
          ok: false,
          reason: "budget_exhausted",
          message: `${String(used)} configuration writes in the last hour; the limit is ${String(this.#limit)}`,
        };
      }
      return target.call("ChangeConfiguration", { key, value });
    });
    const settled = result.catch(() => undefined);
    this.#locks.set(chargerId, settled);
    void settled.then(() => {
      if (this.#locks.get(chargerId) === settled) {
        this.#locks.delete(chargerId);
      }
    });
    return result;
  }
}

export interface ApplyBootConfigOptions {
  readonly store: GatewayStore;
  readonly budget: ConfigWriteBudget;
  readonly logger: Logger;
  readonly heartbeatIntervalSeconds?: number;
}

export interface BootConfigReport {
  /** Keys that were written (whatever the charger answered). */
  readonly written: readonly string[];
  /** Keys left alone because the write budget ran out. */
  readonly skipped: readonly string[];
  /** The configuration stored in `chargers.ocpp_config`, when it could be read. */
  readonly stored: Record<string, string> | undefined;
}

/**
 * Brings a charger's configuration to the boot set. Idempotent: it reads the
 * keys first and writes only those that differ, within the write budget, then
 * reads the whole configuration back and stores it in `chargers.ocpp_config`.
 */
export async function applyBootConfig(
  target: ConfigTarget,
  options: ApplyBootConfigOptions,
): Promise<BootConfigReport> {
  const { store, budget, logger } = options;
  const desired = bootConfiguration(options.heartbeatIntervalSeconds);
  const current = await target.call("GetConfiguration", { key: desired.map(([key]) => key) });
  if (!current.ok) {
    logger.warn({ reason: current.reason }, "could not read the configuration; nothing pushed");
    return { written: [], skipped: [], stored: undefined };
  }
  const written: string[] = [];
  const skipped: string[] = [];
  for (const { key, value } of configDifferences(configToRecord(current.response), desired)) {
    if (skipped.length > 0) {
      skipped.push(key);
      continue;
    }
    const result = await budget.write(target, key, value);
    if (!result.ok && result.reason === "budget_exhausted") {
      logger.warn({ key }, "configuration write budget exhausted; leaving the rest for later");
      skipped.push(key);
      continue;
    }
    written.push(key);
    if (!result.ok || result.response.status !== "Accepted") {
      logger.warn(
        { key, result: result.ok ? result.response.status : result.reason },
        "charger did not accept a configuration value",
      );
    }
  }
  const all = await target.call("GetConfiguration", {});
  if (!all.ok) {
    logger.warn({ reason: all.reason }, "could not read the configuration back");
    return { written, skipped, stored: undefined };
  }
  const stored = configToRecord(all.response);
  await store.saveOcppConfig(target.charger.id, stored);
  logger.info({ written, skipped }, "boot configuration applied");
  return { written, skipped, stored };
}
