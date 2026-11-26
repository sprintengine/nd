// Times for bookings that happen now, in real time. The stack's shortest
// booking is one minute (MIN_BOOKING_MINUTES), so a whole slot fits in a run.

const MINUTE_MS = 60_000;

/** The charger's time zone in every scenario. */
export const TIME_ZONE = "Europe/Dublin";

export interface Slot {
  readonly start: Date;
  readonly end: Date;
}

/** A slot of `minutes` starting on the next whole minute at least `leadSeconds` away. */
export function upcomingSlot(minutes: number, leadSeconds = 20): Slot {
  const earliest = Date.now() + leadSeconds * 1000;
  const start = new Date(Math.ceil(earliest / MINUTE_MS) * MINUTE_MS);
  return { start, end: new Date(start.getTime() + minutes * MINUTE_MS) };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function localParts(instant: Date): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    weekday: WEEKDAYS.indexOf(part("weekday")) + 1,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * One weekly availability window, in the charger's time zone, from an hour
 * ago to eight hours from now: it covers every slot a test books, and the API
 * handles a window that runs past midnight.
 */
export function availabilityAroundNow(): { weekday: number; start: string; end: string }[] {
  const from = localParts(new Date(Date.now() - 60 * MINUTE_MS));
  const to = localParts(new Date(Date.now() + 8 * 60 * MINUTE_MS));
  return [{ weekday: from.weekday, start: from.time, end: to.time }];
}
