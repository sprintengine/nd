import { HttpProblem } from "./http/problem.ts";

/** Result of a command sent to a charger through the OCPP gateway. */
export interface ChargerCommandResult {
  /** The charger's answer, e.g. `Accepted` or `Rejected`. */
  readonly status: string;
}

/**
 * Commands the API sends to chargers. The OCPP gateway implements this behind
 * an internal HTTP endpoint; its typed client plugs in here once it exists.
 */
export interface ChargerControl {
  remoteStart(chargeboxId: string, input: { idTag: string }): Promise<ChargerCommandResult>;
  remoteStop(chargeboxId: string, input: { transactionId: number }): Promise<ChargerCommandResult>;
  triggerMessage(chargeboxId: string, input: { message: string }): Promise<ChargerCommandResult>;
}

/** Stand-in used until the gateway client is wired up: every command answers 503. */
export const unavailableChargerControl: ChargerControl = {
  remoteStart: unavailable,
  remoteStop: unavailable,
  triggerMessage: unavailable,
};

function unavailable(): Promise<never> {
  return Promise.reject(
    new HttpProblem(503, "charger-control-unavailable", "Charger commands are not available yet"),
  );
}
