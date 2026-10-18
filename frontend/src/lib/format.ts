/** Small display helpers. All tolerate missing or malformed input. */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 hours ago", "in 2 days". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  const ahead = seconds > 0;
  const abs = Math.abs(seconds);
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Infinity, "year"],
  ];
  let value = abs;
  let name = "second";
  for (const [size, unit] of units) {
    name = unit;
    if (value < size) break;
    value = Math.floor(value / size);
  }
  if (name === "second" && value < 45) return ahead ? "in a moment" : "just now";
  const label = `${value} ${name}${value === 1 ? "" : "s"}`;
  return ahead ? `in ${label}` : `${label} ago`;
}

/** A forecast date such as "2026-10-11" -> "Sun 11". Parsed by hand to avoid timezone shifts. */
export function shortDay(date: string | null | undefined): string {
  const match = date?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()}`;
}

/** An instant -> "12 Oct, 08:51" in the viewer's own timezone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

/** "2026-10-11T06:02" -> "06:02". */
export function clockTime(local: string | null | undefined): string {
  return local?.match(/T(\d{2}:\d{2})/)?.[1] ?? "";
}

/** 1234 -> "1.2k". */
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function round(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "–" : String(Math.round(value));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** "13.1° N, 80.3° E" */
export function coordinates(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? "E" : "W"}`;
}
