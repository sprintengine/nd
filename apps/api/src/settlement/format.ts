import type { Currency } from "@nd/domain";

// Plain-text formatting for notices and summaries. Money stays in integer
// cents until it is turned into text here.

const SYMBOLS: Record<Currency, string> = { EUR: "€", GBP: "£" };

/** `917` → `€9.17`. */
export function formatMoney(cents: number, currency: Currency): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const rest = String(absolute % 100).padStart(2, "0");
  return `${sign}${SYMBOLS[currency]}${String(whole)}.${rest}`;
}

/** `22.5` → `22.5 kWh`, to one decimal. */
export function formatKwh(kwh: number): string {
  return `${kwh.toFixed(1)} kWh`;
}

/** `220` → `3 h 40 min`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/** `Tue 12 Jan, 22:00` in the charger's time zone. */
export function formatDateTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** `22:00` in the charger's time zone. */
export function formatTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** `Tue 12 Jan, 22:00–01:39`. */
export function formatPeriod(start: Date, end: Date, timeZone: string): string {
  return `${formatDateTime(start, timeZone)}–${formatTime(end, timeZone)}`;
}
