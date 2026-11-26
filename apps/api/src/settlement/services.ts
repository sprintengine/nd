import type { Services } from "../services.ts";
import type { RealtimeNotifier } from "../sessions/services.ts";

/** What settlement needs: the booking services plus the realtime feed, to tell apps what changed. */
export interface SettlementServices extends Services {
  readonly realtime: RealtimeNotifier;
}
