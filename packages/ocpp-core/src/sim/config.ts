import type {
  ConfigurationStatus,
  GetConfigurationResponse,
  KeyValue,
} from "../schemas/central-system.ts";

/** Zappi OCPP charge modes. Values are case-sensitive: "fast" is rejected. */
export const OCPP_CHARGE_MODES = ["Fast", "Eco", "Eco_Plus", "Stop"] as const;
export type OcppChargeMode = (typeof OCPP_CHARGE_MODES)[number];

/** The writable configuration keys the simulated Zappi keeps. */
export interface ZappiConfig {
  /** When true the charger starts on plug-in; when false it idles locked until authorised. */
  readonly FreeCharging: boolean;
  readonly LocalAuthListEnabled: boolean;
  /** Stop (rather than suspend) a transaction whose idTag comes back not Accepted. */
  readonly StopTransactionOnInvalidId: boolean;
  readonly OCPPChargeMode: OcppChargeMode;
  /** Seconds between MeterValues during a transaction; 0 disables them. */
  readonly MeterValueSampleInterval: number;
  /** Seconds between Heartbeats; 0 disables them. */
  readonly HeartbeatInterval: number;
}

export type ZappiConfigKey = keyof ZappiConfig;

export const DEFAULT_ZAPPI_CONFIG: ZappiConfig = {
  FreeCharging: true,
  LocalAuthListEnabled: false,
  StopTransactionOnInvalidId: false,
  OCPPChargeMode: "Fast",
  MeterValueSampleInterval: 900,
  HeartbeatInterval: 300,
};

const WRITABLE_KEYS = Object.keys(DEFAULT_ZAPPI_CONFIG) as readonly ZappiConfigKey[];

/** Keys reported by GetConfiguration that cannot be changed. */
const READONLY_KEYS: Readonly<Record<string, string>> = {
  NumberOfConnectors: "1",
  SupportedFeatureProfiles: "Core,RemoteTrigger",
};

/** The Zappi protects its flash by accepting at most this many writes per rolling window. */
export const DEFAULT_CONFIG_WRITE_LIMIT = 24;
export const DEFAULT_CONFIG_WRITE_WINDOW_MS = 60 * 60 * 1000;

const MAX_INTERVAL_SECONDS = 86_400;

function parseValue(key: ZappiConfigKey, value: string): ZappiConfig[ZappiConfigKey] | undefined {
  switch (key) {
    case "FreeCharging":
    case "LocalAuthListEnabled":
    case "StopTransactionOnInvalidId": {
      const lower = value.toLowerCase();
      return lower === "true" ? true : lower === "false" ? false : undefined;
    }
    case "OCPPChargeMode":
      return (OCPP_CHARGE_MODES as readonly string[]).includes(value)
        ? (value as OcppChargeMode)
        : undefined;
    case "MeterValueSampleInterval":
    case "HeartbeatInterval": {
      if (!/^\d+$/.test(value)) {
        return undefined;
      }
      const seconds = Number(value);
      return seconds <= MAX_INTERVAL_SECONDS ? seconds : undefined;
    }
  }
}

/**
 * The simulated Zappi's configuration, answered through ChangeConfiguration
 * and GetConfiguration. Keys match case-insensitively (they are CiStrings);
 * OCPPChargeMode values do not.
 */
export class ConfigStore {
  readonly writeLimit: number;
  readonly writeWindowMs: number;
  #values: ZappiConfig;
  #writes: number[] = [];

  constructor(
    options: {
      initial?: Partial<ZappiConfig>;
      writeLimit?: number;
      writeWindowMs?: number;
    } = {},
  ) {
    this.#values = { ...DEFAULT_ZAPPI_CONFIG, ...options.initial };
    this.writeLimit = options.writeLimit ?? DEFAULT_CONFIG_WRITE_LIMIT;
    this.writeWindowMs = options.writeWindowMs ?? DEFAULT_CONFIG_WRITE_WINDOW_MS;
  }

  get values(): ZappiConfig {
    return this.#values;
  }

  get<K extends ZappiConfigKey>(key: K): ZappiConfig[K] {
    return this.#values[key];
  }

  /** Sets a value without counting it as a flash write (the charger's own updates). */
  setInternal<K extends ZappiConfigKey>(key: K, value: ZappiConfig[K]): void {
    this.#values = { ...this.#values, [key]: value };
  }

  /** Writes applied inside the current rolling window. */
  writesInWindow(now: number = Date.now()): number {
    this.#writes = this.#writes.filter((at) => now - at < this.writeWindowMs);
    return this.#writes.length;
  }

  /**
   * Applies a ChangeConfiguration. Returns the status to answer with and, when
   * Accepted, the canonical key that changed.
   */
  change(
    key: string,
    value: string,
    now: number = Date.now(),
  ): { status: ConfigurationStatus; key?: ZappiConfigKey } {
    const writable = WRITABLE_KEYS.find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (writable === undefined) {
      const readonly = Object.keys(READONLY_KEYS).some(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      return { status: readonly ? "Rejected" : "NotSupported" };
    }
    if (this.writesInWindow(now) >= this.writeLimit) {
      return { status: "Rejected" };
    }
    const parsed = parseValue(writable, value);
    if (parsed === undefined) {
      return { status: "Rejected" };
    }
    this.#values = { ...this.#values, [writable]: parsed };
    this.#writes.push(now);
    return { status: "Accepted", key: writable };
  }

  /** Answers a GetConfiguration for the given keys, or every key when none are given. */
  read(keys?: readonly string[]): GetConfigurationResponse {
    const all: KeyValue[] = [
      ...WRITABLE_KEYS.map((key) => ({ key, readonly: false, value: String(this.#values[key]) })),
      ...Object.entries(READONLY_KEYS).map(([key, value]) => ({ key, readonly: true, value })),
    ];
    if (keys === undefined || keys.length === 0) {
      return { configurationKey: all };
    }
    const configurationKey: KeyValue[] = [];
    const unknownKey: string[] = [];
    for (const requested of keys) {
      const match = all.find((entry) => entry.key.toLowerCase() === requested.toLowerCase());
      if (match === undefined) {
        unknownKey.push(requested);
      } else {
        configurationKey.push(match);
      }
    }
    return unknownKey.length > 0 ? { configurationKey, unknownKey } : { configurationKey };
  }
}
