import type { ChargerConnection } from "./connection.ts";

/** Close code sent to a socket replaced by a newer one for the same ChargeboxID. */
export const REPLACED_CLOSE_CODE = 4000;

/**
 * The open sockets, one per ChargeboxID. The gateway runs as a single
 * instance, so this in-memory map is the whole picture.
 */
export class ConnectionRegistry {
  readonly #connections = new Map<string, ChargerConnection>();

  get size(): number {
    return this.#connections.size;
  }

  get(chargeboxId: string): ChargerConnection | undefined {
    return this.#connections.get(chargeboxId);
  }

  all(): ChargerConnection[] {
    return [...this.#connections.values()];
  }

  /** Adds a connection; an older one for the same charger is closed and returned. */
  add(connection: ChargerConnection): ChargerConnection | undefined {
    const { chargeboxId } = connection.charger;
    const previous = this.#connections.get(chargeboxId);
    this.#connections.set(chargeboxId, connection);
    if (previous !== undefined && previous !== connection) {
      previous.close(REPLACED_CLOSE_CODE, "Replaced by a newer connection");
      return previous;
    }
    return undefined;
  }

  /** Removes a connection, unless a newer one has already replaced it. */
  remove(connection: ChargerConnection): void {
    if (this.#connections.get(connection.charger.chargeboxId) === connection) {
      this.#connections.delete(connection.charger.chargeboxId);
    }
  }
}
