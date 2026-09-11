/**
 * TZ §8.3 step 0 — RODS day boundaries follow `driver.homeTerminalTimezone`.
 *
 * Implemented on the platform `Intl` database only: the engine must stay dependency-free so
 * the Dart port can mirror it with `timezone`/`TZDateTime` without a behavioural gap, and so
 * `hos/` never drags a runtime package into the mobile bundle.
 *
 * DST correctness (23- and 25-hour days) falls out of this: a "day" is always the interval
 * between two consecutive local midnights, which is 23 h on the spring-forward day and 25 h
 * on the fall-back day — it is never assumed to be 86 400 s.
 */

const MS_PER_MINUTE = 60_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Local wall-clock fields of `instant` in `timeZone`. */
export function wallClock(timeZone: string, instant: Date): WallClock {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // `en-US` renders midnight as hour 24 under some ICU versions even with hourCycle h23.
  const hour = get('hour') % 24;
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') };
}

/** Offset of `timeZone` at `instant`, in milliseconds east of UTC. */
export function offsetMs(timeZone: string, instant: Date): number {
  const w = wallClock(timeZone, instant);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Rounded to the second: `instant` may carry milliseconds the formatter dropped.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** "YYYY-MM-DD" for `instant` in `timeZone` — the RODS log date. */
export function dayKey(timeZone: string, instant: Date): string {
  const w = wallClock(timeZone, instant);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * The UTC instant of a local wall-clock time. Two passes: the first guess uses the offset at
 * the naive UTC instant, the second corrects it when that guess landed on the other side of a
 * DST transition. Local times that do not exist (the spring-forward gap) resolve forward.
 */
export function zonedToUtc(timeZone: string, w: WallClock): Date {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let ts = naive - offsetMs(timeZone, new Date(naive));
  ts = naive - offsetMs(timeZone, new Date(ts));
  return new Date(ts);
}

/** Parses "YYYY-MM-DD". */
export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

/** Local midnight that starts the RODS day `key`. */
export function dayStart(timeZone: string, key: string): Date {
  const { year, month, day } = parseDayKey(key);
  return zonedToUtc(timeZone, { year, month, day, hour: 0, minute: 0, second: 0 });
}

/** Local midnight that ends the RODS day `key` — i.e. the start of the next day. */
export function dayEnd(timeZone: string, key: string): Date {
  return dayStart(timeZone, addDays(key, 1));
}

/** Calendar arithmetic on a "YYYY-MM-DD" key. DST never shifts a calendar date. */
export function addDays(key: string, delta: number): string {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + delta);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Real length of a RODS day in seconds: 82 800 (23 h) / 86 400 / 90 000 (25 h). */
export function dayLengthSec(timeZone: string, key: string): number {
  return Math.round((dayEnd(timeZone, key).getTime() - dayStart(timeZone, key).getTime()) / 1000);
}

/** Every RODS day key touched by [from, to], inclusive, ordered. */
export function dayKeysBetween(timeZone: string, from: Date, to: Date): string[] {
  if (to.getTime() < from.getTime()) return [];
  const last = dayKey(timeZone, to);
  const keys: string[] = [];
  let key = dayKey(timeZone, from);
  // Hard stop: no single recalculation spans more than ~10 years of days.
  for (let guard = 0; guard < 4000; guard += 1) {
    keys.push(key);
    if (key === last) break;
    key = addDays(key, 1);
  }
  return keys;
}

/** Difference between two keys in whole calendar days (`a - b`). */
export function dayDiff(a: string, b: string): number {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  return Math.round(
    (Date.UTC(pa.year, pa.month - 1, pa.day) - Date.UTC(pb.year, pb.month - 1, pb.day)) / (24 * 60 * MS_PER_MINUTE),
  );
}
