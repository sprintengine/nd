/**
 * OCPP 1.6J (JSON over WebSocket): framing, Zod schemas and types for the
 * message subset a myenergi Zappi uses, and a transport-agnostic RPC peer.
 */

export * from "./actions.ts";
export * from "./errors.ts";
export * from "./framing.ts";
export * from "./rpc.ts";
export * from "./schemas/central-system.ts";
export * from "./schemas/charge-point.ts";
export * from "./schemas/common.ts";

/** WebSocket subprotocol a charge point must offer for OCPP 1.6 JSON. */
export const OCPP16_SUBPROTOCOL = "ocpp1.6";

/**
 * Picks the subprotocol to accept from those offered on the WebSocket upgrade.
 * Returns `undefined` when OCPP 1.6 is not offered, and the upgrade must be refused.
 */
export function selectSubprotocol(
  offered: Iterable<string>,
): typeof OCPP16_SUBPROTOCOL | undefined {
  for (const protocol of offered) {
    if (protocol.trim() === OCPP16_SUBPROTOCOL) {
      return OCPP16_SUBPROTOCOL;
    }
  }
  return undefined;
}
