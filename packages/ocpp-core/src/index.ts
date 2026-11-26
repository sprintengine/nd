/** WebSocket subprotocol a charge point must offer for OCPP 1.6 JSON. */
export const OCPP16_SUBPROTOCOL = "ocpp1.6";

/** The first element of every OCPP-J frame. */
export const MessageTypeId = {
  Call: 2,
  CallResult: 3,
  CallError: 4,
} as const;

export type MessageTypeId = (typeof MessageTypeId)[keyof typeof MessageTypeId];

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
