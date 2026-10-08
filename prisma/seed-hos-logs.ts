/**
 * OneBook ELD — HOS logs mock data (web panel `/hos-logs`, Drivers roster, Live Fleet).
 *
 * Seeds 10 driver-day HOS logs for 5 EXISTING drivers:
 *
 *   slot | days                     | current status (right now)
 *   -----+--------------------------+-----------------------------------------------
 *   A    | today-2, today-1, today  | ACTIVE — Driving (open D record, 2nd drive block)
 *   B    | today-2, today-1, today  | ACTIVE — On Duty, not driving (loading at shipper)
 *   C    | today-1, today           | ACTIVE — Driving (open D record)
 *   D    | today                    | ACTIVE — On Duty (pre-trip inspection)
 *   E    | today-1                  | finished shift, Off Duty
 *
 * Every log is a set of §395 duty-status records (`EldEvent`, eventType 1, codes 1..4 =
 * OFF/SB/D/ON) — exactly what `GET /logs/:driverId`, the HOS engine and the roster read — plus
 * the `DailyLog` day header (totals) per log date. An "active" status is simply the LAST record
 * with nothing after it: the engine treats it as running until now.
 *
 * Times are relative to the real "now": today's shift ENDS now (its last record is open), the
 * previous days' shifts start at ~05:00 local on their own calendar day. Today's shift never
 * starts before 00:30 or less than 10h after yesterday's (finished segments are compressed when
 * the seed runs early in the morning), so the active drivers are active whenever the seed is run,
 * days never overlap, and every shift stays within the 11h driving / 14h window / 30-min break
 * rules.
 *
 * `EldEvent` is append-only (no UPDATE/DELETE), so the seed is idempotent per driver: a driver
 * who already has any record inside the mock window is skipped. For a fresh "active now" timeline
 * on a later day, re-run it after the previous mock window has passed (or reset the dev DB).
 *
 * Used two ways:
 *   1. from `prisma/seed.ts` (npm run db:seed) — with the demo drivers that seed creates;
 *   2. standalone (npm run db:seed:hos-logs) — against an existing DB. Drivers are resolved by
 *      username from SEED_HOS_DRIVERS (comma-separated, 5 names, slot order A..E) or default to
 *      the demo usernames `prisma/seed.ts` creates.
 */
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { PrismaClient, Prisma } from '@prisma/client';
import { computeChecksum } from '../src/modules/ingest/checksum';
import { EVENT_SEQUENCE_MIN, nextSequenceId } from '../src/modules/ingest/event-codes';
import { offsetMs } from '../src/modules/hos/engine/timezone';
import { coarsenLocation } from '../src/common/units/location';

type Duty = 'OFF' | 'SB' | 'D' | 'ON';

const EVENT_TYPE_DUTY_STATUS = 1;
const CODE_BY_DUTY: Record<Duty, number> = { OFF: 1, SB: 2, D: 3, ON: 4 };
/** §7.2 record origin — 1 = automatically recorded by the ELD (driving), 2 = entered by driver. */
const ORIGIN_BY_DUTY: Record<Duty, number> = { OFF: 2, SB: 2, D: 1, ON: 2 };
const AVG_SPEED_MPH = 55;

/** Demo usernames created by prisma/seed.ts (slots A..E). */
export const DEFAULT_HOS_MOCK_USERNAMES = ['williambond', 'davidperez3', 'richardlewis4', 'josephscott5', 'thomasnelson6'];

export interface HosMockDriver {
  id: string;
  timezone: string;
  vehicleId: string | null;
}

interface Place {
  name: string;
  lat: number;
  lon: number;
}

/** One duty segment: `min` = duration in minutes; `null` = open (still running right now). */
interface Seg {
  s: Duty;
  min: number | null;
  at: Place;
}

interface Shift {
  /** Days before today's shift start (0 = today, 1 = yesterday, 2 = day before). */
  daysAgo: number;
  segs: Seg[];
}

const P = {
  columbus: { name: 'Columbus, OH', lat: 39.9612, lon: -82.9988 },
  springfield: { name: '3 mi W of Springfield, OH', lat: 39.9242, lon: -83.8641 },
  dayton: { name: 'Dayton, OH', lat: 39.7589, lon: -84.1916 },
  richmond: { name: '2 mi E of Richmond, IN', lat: 39.8289, lon: -84.8902 },
  indianapolis: { name: 'Indianapolis, IN', lat: 39.7684, lon: -86.1581 },
  terreHaute: { name: '4 mi S of Terre Haute, IN', lat: 39.4667, lon: -87.4139 },
  effingham: { name: 'Effingham, IL', lat: 39.1200, lon: -88.5434 },
  stLouis: { name: 'St. Louis, MO', lat: 38.627, lon: -90.1994 },
  chicago: { name: 'Chicago, IL', lat: 41.8781, lon: -87.6298 },
  joliet: { name: '5 mi SW of Joliet, IL', lat: 41.525, lon: -88.0817 },
  bloomington: { name: 'Bloomington, IL', lat: 40.4842, lon: -88.9937 },
  springfieldIl: { name: 'Springfield, IL', lat: 39.7817, lon: -89.6501 },
  gary: { name: 'Gary, IN', lat: 41.5934, lon: -87.3464 },
  toledo: { name: 'Toledo, OH', lat: 41.6528, lon: -83.5379 },
  cleveland: { name: 'Cleveland, OH', lat: 41.4993, lon: -81.6944 },
  akron: { name: '2 mi N of Akron, OH', lat: 41.0814, lon: -81.519 },
  pittsburgh: { name: 'Pittsburgh, PA', lat: 40.4406, lon: -79.9959 },
  cincinnati: { name: 'Cincinnati, OH', lat: 39.1031, lon: -84.512 },
  florence: { name: '1 mi N of Florence, KY', lat: 38.9989, lon: -84.6266 },
  lexington: { name: 'Lexington, KY', lat: 38.0406, lon: -84.5037 },
  louisville: { name: 'Louisville, KY', lat: 38.2527, lon: -85.7585 },
  nashville: { name: 'Nashville, TN', lat: 36.1627, lon: -86.7816 },
  bowlingGreen: { name: '3 mi W of Bowling Green, KY', lat: 36.9685, lon: -86.4808 },
} satisfies Record<string, Place>;

/**
 * Slot plans (A..E). Previous-day shifts are <= 11h driving, <= 14h window, with a 30-min
 * break before 8h of driving, and end in OFF/SB so the next shift starts after a full rest.
 */
const PLANS: Array<{ label: string; odometerStart: number; engineHoursStart: number; shifts: Shift[] }> = [
  {
    label: 'A — 3 days, ACTIVE driving',
    odometerStart: 412_380,
    engineHoursStart: 9_812.4,
    shifts: [
      {
        daysAgo: 2,
        segs: [
          { s: 'ON', min: 20, at: P.columbus },
          { s: 'D', min: 300, at: P.columbus },
          { s: 'OFF', min: 30, at: P.indianapolis },
          { s: 'D', min: 210, at: P.indianapolis },
          { s: 'ON', min: 15, at: P.stLouis },
          { s: 'OFF', min: null, at: P.stLouis },
        ],
      },
      {
        daysAgo: 1,
        segs: [
          { s: 'ON', min: 15, at: P.stLouis },
          { s: 'D', min: 270, at: P.stLouis },
          { s: 'OFF', min: 30, at: P.indianapolis },
          { s: 'D', min: 240, at: P.indianapolis },
          { s: 'ON', min: 30, at: P.columbus },
          { s: 'OFF', min: null, at: P.columbus },
        ],
      },
      {
        daysAgo: 0,
        segs: [
          { s: 'ON', min: 15, at: P.columbus },
          { s: 'D', min: 180, at: P.columbus },
          { s: 'OFF', min: 30, at: P.richmond },
          { s: 'D', min: null, at: P.richmond }, // ACTIVE — driving since ~80 min ago
        ],
      },
    ],
  },
  {
    label: 'B — 3 days, ACTIVE on duty',
    odometerStart: 288_904,
    engineHoursStart: 7_120.75,
    shifts: [
      {
        daysAgo: 2,
        segs: [
          { s: 'ON', min: 15, at: P.chicago },
          { s: 'D', min: 240, at: P.chicago },
          { s: 'OFF', min: 30, at: P.bloomington },
          { s: 'D', min: 300, at: P.bloomington },
          { s: 'ON', min: 20, at: P.effingham },
          { s: 'SB', min: null, at: P.effingham },
        ],
      },
      {
        daysAgo: 1,
        segs: [
          { s: 'ON', min: 15, at: P.effingham },
          { s: 'D', min: 310, at: P.effingham },
          { s: 'ON', min: 60, at: P.springfieldIl },
          { s: 'D', min: 180, at: P.springfieldIl },
          { s: 'ON', min: 15, at: P.joliet },
          { s: 'OFF', min: null, at: P.joliet },
        ],
      },
      {
        daysAgo: 0,
        segs: [
          { s: 'ON', min: 20, at: P.joliet },
          { s: 'D', min: 160, at: P.joliet },
          { s: 'ON', min: null, at: P.gary }, // ACTIVE — loading at shipper since ~45 min ago
        ],
      },
    ],
  },
  {
    label: 'C — 2 days, ACTIVE driving',
    odometerStart: 157_215,
    engineHoursStart: 4_388.1,
    shifts: [
      {
        daysAgo: 1,
        segs: [
          { s: 'ON', min: 15, at: P.cleveland },
          { s: 'D', min: 360, at: P.cleveland },
          { s: 'OFF', min: 30, at: P.toledo },
          { s: 'D', min: 290, at: P.toledo },
          { s: 'ON', min: 20, at: P.akron },
          { s: 'OFF', min: null, at: P.akron },
        ],
      },
      {
        daysAgo: 0,
        segs: [
          { s: 'ON', min: 20, at: P.akron },
          { s: 'D', min: null, at: P.akron }, // ACTIVE — driving since ~2h10 ago
        ],
      },
    ],
  },
  {
    label: 'D — 1 day, ACTIVE on duty (pre-trip)',
    odometerStart: 96_430,
    engineHoursStart: 2_210.5,
    shifts: [
      {
        daysAgo: 0,
        segs: [
          { s: 'SB', min: 480, at: P.florence },
          { s: 'ON', min: null, at: P.florence }, // ACTIVE — pre-trip inspection since ~35 min ago
        ],
      },
    ],
  },
  {
    label: 'E — 1 day (yesterday), finished, off duty',
    odometerStart: 341_002,
    engineHoursStart: 8_045.25,
    shifts: [
      {
        daysAgo: 1,
        segs: [
          { s: 'ON', min: 15, at: P.louisville },
          { s: 'D', min: 240, at: P.louisville },
          { s: 'OFF', min: 30, at: P.bowlingGreen },
          { s: 'D', min: 225, at: P.bowlingGreen },
          { s: 'ON', min: 20, at: P.nashville },
          { s: 'OFF', min: null, at: P.nashville },
        ],
      },
    ],
  },
];

/** How long the still-open record of today's shift has been running (slots A..D). */
const OPEN_FOR_MIN = [80, 45, 130, 35];

interface PlannedEvent {
  at: DateTime;
  duty: Duty;
  place: Place;
  miles: number;
  engineHours: number;
}

export function buildTimeline(planIndex: number, now: DateTime, timezone: string): PlannedEvent[] {
  const plan = PLANS[planIndex];
  const today = plan.shifts.find((s) => s.daysAgo === 0);
  const closedMin = (shift: Shift): number => shift.segs.reduce((sum, seg) => sum + (seg.min ?? 0), 0);
  const midnight = now.setZone(timezone).startOf('day');

  // Previous days' shifts start at a fixed local clock time (05:00 + 10 min per slot) so each
  // one stays inside its own calendar day; today's shift ENDS now (its last record is open).
  let dayShift = 0;
  const prevStart = (daysAgo: number): DateTime =>
    midnight.minus({ days: daysAgo + dayShift }).set({ hour: 5, minute: planIndex * 10 });
  const yesterday = plan.shifts.find((s) => s.daysAgo === 1);
  const prevEnd = yesterday ? prevStart(1).plus({ minutes: closedMin(yesterday) }) : null;

  let todayStart = now;
  let scale = 1;
  let openMin = OPEN_FOR_MIN[planIndex] ?? 0;
  if (today) {
    const closed = closedMin(today);
    const ideal = now.minus({ minutes: closed + openMin });
    // Never before 00:30 today, and always >= 10h off duty after yesterday's shift.
    let earliest: DateTime = midnight.plus({ minutes: 30 });
    if (prevEnd && prevEnd.plus({ hours: 10 }) > earliest) earliest = prevEnd.plus({ hours: 10 });
    if (ideal >= earliest) {
      todayStart = ideal;
    } else {
      const available = now.diff(earliest, 'minutes').minutes;
      if (available >= 30) {
        // Seeded early in the day: compress today's finished segments to fit since `earliest`.
        openMin = Math.min(openMin, Math.max(10, Math.floor(available * 0.3)));
        scale = (available - openMin) / closed;
        todayStart = earliest;
      } else {
        // Just after midnight: keep today's shift as planned, move earlier days one day back.
        todayStart = ideal;
        dayShift = 1;
      }
    }
  }

  const events: PlannedEvent[] = [];
  let miles = plan.odometerStart;
  let engineHours = plan.engineHoursStart;
  const shifts = [...plan.shifts].sort((a, b) => b.daysAgo - a.daysAgo);
  for (const shift of shifts) {
    let cursor = shift.daysAgo === 0 ? todayStart : prevStart(shift.daysAgo);
    for (const seg of shift.segs) {
      events.push({ at: cursor, duty: seg.s, place: seg.at, miles, engineHours: Math.round(engineHours * 100) / 100 });
      if (seg.min === null) break;
      const min = shift.daysAgo === 0 && scale !== 1 ? Math.max(5, Math.round(seg.min * scale)) : seg.min;
      if (seg.s === 'D') miles += Math.round((min / 60) * AVG_SPEED_MPH);
      if (seg.s === 'D' || seg.s === 'ON') engineHours += min / 60;
      cursor = cursor.plus({ minutes: min });
    }
  }
  return events;
}

/** Per-local-day totals from the timeline (time before the first record counts as OFF). */
export function dayTotals(events: PlannedEvent[], timezone: string, now: DateTime) {
  const byDay = new Map<string, { OFF: number; SB: number; D: number; ON: number; miles: number }>();
  const bucket = (key: string) => {
    if (!byDay.has(key)) byDay.set(key, { OFF: 0, SB: 0, D: 0, ON: 0, miles: 0 });
    return byDay.get(key)!;
  };
  const first = events[0].at.setZone(timezone).startOf('day');
  // Lead-in OFF from local midnight to the first record.
  bucket(first.toISODate()!).OFF += Math.round(events[0].at.diff(first, 'seconds').seconds);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const end = i + 1 < events.length ? events[i + 1].at : now;
    let from = ev.at.setZone(timezone);
    while (from < end) {
      const dayEnd = from.startOf('day').plus({ days: 1 });
      const to = end < dayEnd ? end : dayEnd;
      const sec = Math.round(to.diff(from, 'seconds').seconds);
      const b = bucket(from.toISODate()!);
      b[ev.duty] += sec;
      if (ev.duty === 'D') b.miles += Math.round((sec / 3600) * AVG_SPEED_MPH);
      from = to.setZone(timezone);
    }
  }
  // Only the days that actually carry a shift record are mock "logs".
  const shiftDays = new Set(events.filter((e) => e.duty !== 'OFF' && e.duty !== 'SB').map((e) => e.at.setZone(timezone).toISODate()!));
  return [...byDay.entries()].filter(([day]) => shiftDays.has(day));
}

async function allocateSequenceIds(tx: Prisma.TransactionClient, driverId: string, count: number): Promise<number[]> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, `eldseq:${driverId}`);
  const existing = await tx.eventSequenceCounter.findUnique({ where: { key: driverId } });
  let last = existing?.lastSequenceId ?? 0;
  if (!existing) {
    const row = await tx.eldEvent.findFirst({
      where: { driverId },
      orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
      select: { eventSequenceId: true },
    });
    last = row?.eventSequenceId ?? 0;
  }
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    last = last === 0 ? EVENT_SEQUENCE_MIN : nextSequenceId(last);
    ids.push(last);
  }
  await tx.eventSequenceCounter.upsert({
    where: { key: driverId },
    create: { key: driverId, lastSequenceId: last },
    update: { lastSequenceId: last },
  });
  return ids;
}

/** Seeds the 10 mock HOS logs. `drivers` = slots A..E (exactly 5). Returns a short summary. */
export async function seedHosLogs(prisma: PrismaClient, drivers: HosMockDriver[], nowJs: Date = new Date()): Promise<string[]> {
  if (drivers.length !== PLANS.length) {
    throw new Error(`seedHosLogs needs ${PLANS.length} drivers (slots A..E), got ${drivers.length}`);
  }
  const now = DateTime.fromJSDate(nowJs).set({ second: 0, millisecond: 0 });
  const summary: string[] = [];

  for (const [i, driver] of drivers.entries()) {
    const plan = PLANS[i];
    const timeline = buildTimeline(i, now, driver.timezone);
    const windowStart = timeline[0].at.toJSDate();

    const already = await prisma.eldEvent.findFirst({
      where: { driverId: driver.id, eventDateTime: { gte: windowStart } },
      select: { id: true },
    });
    if (already) {
      summary.push(`${plan.label}: skipped (driver ${driver.id} already has records in the mock window)`);
      continue;
    }

    await prisma.$transaction(
      async (tx) => {
        const months = new Set(timeline.map((e) => e.at.toUTC().startOf('month').toISODate()!));
        for (const month of months) {
          await tx.$executeRawUnsafe(`SELECT ensure_event_partition($1::date)`, month);
        }
        const sequenceIds = await allocateSequenceIds(tx, driver.id, timeline.length);
        const rows: Prisma.EldEventCreateManyInput[] = timeline.map((ev, idx) => {
          const at = ev.at.toJSDate();
          const position = coarsenLocation({ lat: ev.place.lat, lon: ev.place.lon }, 'ONE_MILE');
          const base = {
            uuid: randomUUID(),
            eventType: EVENT_TYPE_DUTY_STATUS,
            eventCode: CODE_BY_DUTY[ev.duty],
            eventDateTime: at,
            timezoneOffset: Math.round(offsetMs(driver.timezone, at) / 60_000),
            recordStatus: 1,
            recordOrigin: ORIGIN_BY_DUTY[ev.duty],
            latitude: Number(position.lat.toFixed(6)),
            longitude: Number(position.lon.toFixed(6)),
            rawDeviceOdometerKm: Math.round(ev.miles * 1.609344),
            totalEngineHours: ev.engineHours,
          };
          return {
            ...base,
            driverId: driver.id,
            vehicleId: driver.vehicleId,
            eventSequenceId: sequenceIds[idx],
            locationPrecisionMi: 1,
            locationName: ev.place.name,
            locationSource: 1,
            totalVehicleMiles: ev.miles,
            checksum: computeChecksum(base),
          };
        });
        await tx.eldEvent.createMany({ data: rows, skipDuplicates: true });

        for (const [day, t] of dayTotals(timeline, driver.timezone, now)) {
          const logDate = new Date(`${day}T00:00:00.000Z`);
          const totals = { offDutySec: t.OFF, sleeperSec: t.SB, drivingSec: t.D, onDutySec: t.ON, totalDistanceMi: t.miles };
          await tx.dailyLog.upsert({
            where: { driverId_logDate: { driverId: driver.id, logDate } },
            create: { driverId: driver.id, logDate, timezone: driver.timezone, ...totals },
            update: { ...totals, recalculatedAt: new Date() },
          });
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    const last = timeline[timeline.length - 1];
    summary.push(`${plan.label}: ${timeline.length} records for driver ${driver.id}; now ${last.duty} since ${last.at.setZone(driver.timezone).toFormat('yyyy-MM-dd HH:mm ZZZZ')}`);
  }
  return summary;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const usernames = (process.env.SEED_HOS_DRIVERS?.split(',') ?? DEFAULT_HOS_MOCK_USERNAMES).map((u) => u.trim()).filter(Boolean);
    const drivers: HosMockDriver[] = [];
    for (const username of usernames) {
      const d = await prisma.driver.findFirst({ where: { username, deletedAt: null } });
      if (!d) {
        throw new Error(
          `Driver "${username}" not found. Run \`npm run db:seed\` first, or set SEED_HOS_DRIVERS to 5 existing usernames (slots A..E).`,
        );
      }
      drivers.push({ id: d.id, timezone: d.homeTerminalTimezone, vehicleId: d.assignedVehicleId });
    }
    const summary = await seedHosLogs(prisma, drivers);
    console.log(`HOS logs mock seeded:\n  ${summary.join('\n  ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
