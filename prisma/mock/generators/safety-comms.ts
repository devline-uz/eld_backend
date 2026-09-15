/**
 * OneBook ELD — mock generator: safety-comms (safety events, driver scores, coaching,
 * conversations/messages/broadcasts, support tickets, feedback, and the messaging-/safety-/
 * coaching-related notifications). Runs after `core -> users -> hos -> ingest -> compliance`,
 * before `fleet` in wall-clock terms doesn't matter (fleet owns a disjoint set of tables), but
 * the *pipeline* order is fixed at `... -> fleet -> safety-comms -> reports`.
 *
 * Mock identity (see prisma/mock/README.md):
 *   SafetyEvent / DriverScore   — reached transitively via mock Driver.id / Vehicle.id FKs.
 *   Conversation                — reached transitively: every conversation this generator
 *                                 creates has >=1 mock-driver participant (dispatcher<->driver
 *                                 messaging always includes a driver side); found via
 *                                 ConversationParticipant.driverId IN (mock driver ids).
 *                                 Cascade deletes ConversationParticipant + Message with it.
 *   Notification                — no FK identity of its own; owned exclusively by `type IN
 *                                 NOTIFICATION_TYPES` (message.new / safety.*), which no other
 *                                 domain writes (the reports agent owns alert-rule notification
 *                                 types and is never touched here).
 *   SupportTicket                — tagged via `number` starting "TCK-MOCK-" (SupportTicket has
 *                                 no FK back to a mock driver/vehicle/user when createdBy is a
 *                                 real seeded dispatcher, so a text-prefix identity is used, same
 *                                 pattern as core.ts's MOCKTRL-/MOCKPT30- prefixes).
 *   Feedback                     — reached transitively via mock Driver.id, OR tagged with the
 *                                 literal "[mock]" marker in `comment` when authored by a real
 *                                 seeded user.
 */
import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import { CoachingStatus, ConversationType, Prisma, SafetyEventType, TicketPriority, TicketStatus } from '@prisma/client';
import { computeDriverScore } from '../../../src/modules/safety/lib/harsh-detect';
import { EVENT_TYPE, DUTY_CODE } from '../../../src/modules/ingest/event-codes';
import { MockContext, MOCK_TAG, clampToNow } from '../context';
import {
  activeDaysFraction,
  pickStatus,
  ratesForRisk,
  riskFactor,
  severityFromDelta,
  statusWeightsForAgeDays,
} from './safety-comms.lib';

const MOCK_USERNAME_PREFIX = 'mock_';
const MOCK_UNIT_PREFIX = 'M1';
const MOCK_TICKET_PREFIX = 'TCK-MOCK-';

/** Every Notification `type` this generator (and only this generator) owns. */
const NOTIFICATION_TYPES = ['message.new', 'safety.new_event', 'safety.coaching_assigned', 'safety.coaching_completed'];

const CHUNK = 5000;

async function createManyChunked<T>(fn: (rows: T[]) => Promise<unknown>, rows: T[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await fn(rows.slice(i, i + CHUNK));
  }
}

// -------------------------------------------------------------------------------------------
// Reference data — realistic locations, message/coaching/ticket copy
// -------------------------------------------------------------------------------------------

/** Fallback route waypoints (used only when telemetry/EldEvent locations aren't available). */
const FALLBACK_WAYPOINTS: Array<{ name: string; lat: number; lon: number; speedLimitMph: number }> = [
  { name: 'I-70 near Columbus, OH', lat: 39.9612, lon: -82.9988, speedLimitMph: 70 },
  { name: 'I-75 near Atlanta, GA', lat: 33.749, lon: -84.388, speedLimitMph: 65 },
  { name: 'I-85 near Charlotte, NC', lat: 35.2271, lon: -80.8431, speedLimitMph: 70 },
  { name: 'I-90 near Chicago, IL', lat: 41.8781, lon: -87.6298, speedLimitMph: 55 },
  { name: 'I-35 near Dallas, TX', lat: 32.7767, lon: -96.797, speedLimitMph: 75 },
  { name: 'I-70 near Kansas City, MO', lat: 39.0997, lon: -94.5786, speedLimitMph: 70 },
  { name: 'I-25 near Denver, CO', lat: 39.7392, lon: -104.9903, speedLimitMph: 65 },
  { name: 'I-10 near Phoenix, AZ', lat: 33.4484, lon: -112.074, speedLimitMph: 75 },
  { name: 'I-5 near Los Angeles, CA', lat: 34.0522, lon: -118.2437, speedLimitMph: 65 },
  { name: 'I-5 near Seattle, WA', lat: 47.6062, lon: -122.3321, speedLimitMph: 60 },
  { name: 'I-40 near Memphis, TN', lat: 35.1495, lon: -90.049, speedLimitMph: 70 },
  { name: 'I-65 near Indianapolis, IN', lat: 39.7684, lon: -86.1581, speedLimitMph: 70 },
  { name: 'I-24 near Nashville, TN', lat: 36.1627, lon: -86.7816, speedLimitMph: 70 },
  { name: 'I-64 near Louisville, KY', lat: 38.2527, lon: -85.7585, speedLimitMph: 65 },
  { name: 'I-95 near Jacksonville, FL', lat: 30.3322, lon: -81.6557, speedLimitMph: 70 },
  { name: 'I-80 near Salt Lake City, UT', lat: 40.7608, lon: -111.891, speedLimitMph: 75 },
  { name: 'I-84 near Portland, OR', lat: 45.5152, lon: -122.6784, speedLimitMph: 60 },
  { name: 'I-40 near Oklahoma City, OK', lat: 35.4676, lon: -97.5164, speedLimitMph: 75 },
];

function jitter(rng: MockContext['rng'], value: number, spread: number): number {
  return value + rng.float(-spread, spread);
}

/**
 * Clamps a candidate `readAt` to `ctx.to` (never a future timestamp — B-048) and, if the
 * clamped result would land before `createdAt` (i.e. the random "read N hours later" offset got
 * entirely clamped away), leaves the notification unread (`null`) instead of reporting a read
 * that happened before the notification existed.
 */
function readAtOrNull(candidate: Date, createdAt: Date, ctx: MockContext): Date | null {
  const clamped = clampToNow(candidate, ctx);
  return clamped.getTime() < createdAt.getTime() ? null : clamped;
}

const COACHING_NOTES: Record<string, string[]> = {
  HARSH_BRAKING: [
    'Reviewed dashcam clip with driver — following distance too short on wet pavement. Coached on 4-second rule.',
    'Discussed late braking approaching a stale yellow light. Driver acknowledged, no excuse given.',
    'Pattern of hard stops in the same corridor — advised driver to anticipate the merge, not react to it.',
  ],
  HARSH_ACCEL: [
    'Coached on smoother throttle application pulling away from stops — fuel economy and load security both affected.',
    'Aggressive acceleration merging onto the interstate. Reviewed with driver, retrained on gap acceptance.',
  ],
  HARSH_TURN: [
    'Sharp lane change flagged by the system — driver says a vehicle cut in front. Reviewed footage, no fault found, closed out.',
    'Coached on reducing speed before tight ramp turns; driver was above the advisory speed for the curve.',
  ],
  SPEEDING: [
    'Driver was 12+ mph over posted limit in a construction zone. Written coaching issued, driver acknowledged.',
    'Repeated speeding on I-70 corridor — escalated to a documented coaching conversation, follow-up scheduled in 30 days.',
    'Minor speeding over a short downhill grade. Verbal reminder only, isolated incident.',
  ],
  SEATBELT: [
    'Driver unbuckled for a yard maneuver that was misclassified as over-the-road. Corrected event, coached on classification.',
    'Seatbelt off for an extended highway segment. Serious safety conversation held, documented in file.',
  ],
};

const REVIEW_DISMISS_NOTES = [
  'Reviewed telemetry — event consistent with an unavoidable evasive maneuver, no coaching needed.',
  'False positive from a rough road section, confirmed against dashcam. Dismissed.',
  'Reviewed and confirmed as a legitimate hard-brake for a pedestrian in the crosswalk. No action needed.',
];

const DISPATCH_TO_DRIVER: string[] = [
  'Heads up — {dest} dock closes at {time}, plan your 30 accordingly.',
  'Load for unit {unit} is ready at {origin}, BOL is in the mobile app.',
  'Traffic is backed up on the corridor near {city} — consider the alternate route if you have HOS to spare.',
  'Can you confirm your ETA into {dest}? Customer is asking.',
  'Weather advisory for your route today — winter storm warning near {city}, drive safe.',
  'Nice work getting that load in early yesterday — appreciated.',
  'Reminder: pre-trip DVIR is showing incomplete for unit {unit}. Please complete before rolling.',
  'New load assigned, pickup at {origin} tomorrow morning. Details in the app.',
  'Customer moved the delivery window at {dest} — now closes two hours earlier, see updated BOL.',
  "Don't forget your 34-hour restart resets tonight if you stay off-duty through midnight.",
];

const DRIVER_TO_DISPATCH: string[] = [
  'Copy that, heading to {dest} now.',
  'Running about 45 min behind due to construction near {city}, will update ETA.',
  'Unit {unit} throwing a check engine light, pulling into the next truck stop to check it.',
  'Picked up at {origin}, all good, rolling now.',
  "I'm out of hours for today, going to have to stop short of {dest}, resuming in the morning.",
  'Confirmed, dock 12 at {dest}, thanks.',
  'Trailer tires look low, can we get a work order started for when I get back to the yard?',
  'Delivered at {dest}, POD signed and uploaded.',
  'Can I get a lumper reimbursement code for this stop?',
  'All good here, no issues, see you at the next check-in.',
];

const GROUP_TITLES = [
  'Midwest Fleet — Dispatch',
  'Southeast Region Drivers',
  'West Coast Team',
  'Overnight Runs — Dispatch',
  'Reefer Team Chat',
  'New Hire Onboarding Cohort',
];

const GROUP_MESSAGES = [
  'Morning team — road conditions on I-70 are rough east of the state line, use caution.',
  'Reminder: DOT roadside inspection blitz this week, make sure your paperwork is current.',
  'Great job hitting on-time delivery numbers this month, team — over 95%!',
  'Fuel prices dropped at the Flying J on exit 42, worth a stop if you are in the area.',
  'Holiday schedule is posted — check the app for your assigned days.',
  'Anyone running through the Chicago corridor today, expect delays near the interchange.',
];

const BROADCAST_TITLES_BODIES: Array<{ title: string; body: string }> = [
  { title: 'Winter storm advisory', body: 'Severe winter weather expected across the northern corridor tonight through tomorrow morning. Use extra caution, delay if conditions are unsafe, and check in with dispatch before departing.' },
  { title: 'DOT audit week', body: 'FMCSA is conducting roadside inspections in our operating region this week. Make sure your logs, medical card, and registration are current and accessible.' },
  { title: 'Holiday schedule', body: 'Office hours over the holiday are reduced — dispatch will be reachable but response times may be slower. Plan your loads accordingly.' },
  { title: 'New PT30 firmware', body: 'Your ELD device will receive a firmware update overnight. No action needed, but you may see the unit briefly reconnect.' },
  { title: 'Safety stand-down reminder', body: "This quarter's safety stand-down meeting is mandatory. Sign up for a slot in the driver app under Support." },
  { title: 'Fuel card update', body: 'Fuel cards are being reissued this month. Continue using your current card until you receive the new one in the mail.' },
  { title: 'Speed policy reminder', body: 'Company policy caps speed at 65 mph regardless of posted limit. Repeated violations will result in a documented coaching session.' },
  { title: 'App update available', body: 'A new version of the driver app is available with HOS clock fixes. Please update at your next stop with wifi.' },
  { title: 'Seatbelt compliance', body: 'Seatbelt usage is mandatory at all times the vehicle is in motion, including yard moves. This is a zero-tolerance policy.' },
  { title: 'Terminal maintenance closure', body: 'The Columbus terminal yard will be closed for repaving this weekend. Use the overflow lot on Freight Way instead.' },
  { title: 'Rate confirmation reminder', body: 'Please confirm receipt of your rate confirmation for this week before starting your route.' },
  { title: 'Detention pay policy', body: 'Detention pay now kicks in after 90 minutes at a shipper/receiver, not two hours. Log your arrival/departure times accurately.' },
];

const TICKET_TEMPLATES: Array<{ category: string; subject: string; body: string; priority: TicketPriority }> = [
  { category: 'ELD_DEVICE', subject: 'PT30 not connecting via Bluetooth', priority: TicketPriority.HIGH, body: 'The PT30 unit will not pair with my phone since this morning. I have restarted both. Cannot log driving time.' },
  { category: 'ELD_DEVICE', subject: 'Device shows wrong odometer', priority: TicketPriority.NORMAL, body: 'The odometer on the app is off by about 4,000 miles from the dash. Can someone recalibrate it?' },
  { category: 'APP', subject: 'App crashes when certifying logs', priority: TicketPriority.URGENT, body: 'Every time I try to certify yesterday\'s log the app closes. I need to certify before my shift starts.' },
  { category: 'APP', subject: 'Cannot see my HOS clocks', priority: TicketPriority.HIGH, body: 'My 70-hour clock is not showing on the home screen since the last update.' },
  { category: 'ACCOUNT', subject: 'Forgot PIN', priority: TicketPriority.NORMAL, body: 'I forgot my driver PIN and cannot log in to the tablet. Can you reset it?' },
  { category: 'ACCOUNT', subject: 'Wrong home terminal listed', priority: TicketPriority.LOW, body: 'My home terminal shows Dallas but I transferred to the Denver terminal last month.' },
  { category: 'PAYROLL', subject: 'Missing detention pay', priority: TicketPriority.NORMAL, body: 'I was detained over 3 hours at the Memphis DC last week and it is not showing on my settlement.' },
  { category: 'EQUIPMENT', subject: 'Trailer lights out', priority: TicketPriority.HIGH, body: 'Left rear trailer light is out on trailer, reported on DVIR twice, still not fixed.' },
  { category: 'COMPLIANCE', subject: 'Unidentified driving segment needs review', priority: TicketPriority.NORMAL, body: 'There is an unidentified driving segment on my log from Tuesday that is actually a yard move by the shop.' },
  { category: 'OTHER', subject: 'Question about split sleeper', priority: TicketPriority.LOW, body: 'Can someone walk me through how to use the split sleeper berth exception correctly in the app?' },
];

const TICKET_REPLIES: Record<TicketStatus, string[]> = {
  OPEN: [],
  IN_PROGRESS: ['\n\n--- Support reply ---\nThanks for the report, looking into this now, will follow up shortly.'],
  RESOLVED: [
    '\n\n--- Support reply ---\nThanks for the report, looking into this now, will follow up shortly.',
    '\n\n--- Support reply ---\nThis has been fixed / addressed. Please confirm on your end and let us know if it recurs.',
  ],
  CLOSED: [
    '\n\n--- Support reply ---\nThanks for the report, looking into this now, will follow up shortly.',
    '\n\n--- Support reply ---\nThis has been fixed / addressed. Please confirm on your end and let us know if it recurs.',
    '\n\n--- Support reply ---\nConfirmed resolved by the driver. Closing this ticket.',
  ],
};

const FEEDBACK_COMMENTS = [
  'App is much faster since the last update, great work.',
  'Would love a dark mode for night driving.',
  'HOS clock sometimes lags a minute or two behind real time.',
  'PT30 pairing is flaky when I have a phone case with a magnet mount.',
  'Support resolved my issue same day, appreciated.',
  '',
  '',
];

// -------------------------------------------------------------------------------------------
// Generator
// -------------------------------------------------------------------------------------------

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const { prisma, rng, from, to, log } = ctx;

  const drivers = await prisma.driver.findMany({
    where: { username: { startsWith: MOCK_USERNAME_PREFIX } },
    select: { id: true, assignedVehicleId: true, homeTerminalTimezone: true, status: true, registeredAt: true, fleetManagerId: true },
  });
  const mockDriverIds = drivers.map((d) => d.id);
  const vehicles = await prisma.vehicle.findMany({
    where: { unitNumber: { startsWith: MOCK_UNIT_PREFIX } },
    select: { id: true, unitNumber: true },
  });
  const mockVehicleIds = vehicles.map((v) => v.id);
  if (drivers.length === 0 || vehicles.length === 0) {
    throw new Error('safety-comms: no mock drivers/vehicles found — run `npm run db:mock -- core` first.');
  }

  const users = await prisma.user.findMany({ select: { id: true, email: true, role: { select: { key: true } } } });
  const coachPool = users.filter((u) => u.role.key === 'FLEET_MANAGER' || u.role.key === 'ADMIN');
  const dispatcherPool = users.filter((u) => u.role.key === 'DISPATCHER' || u.role.key === 'ADMIN');
  const sarahChen = users.find((u) => u.email === 'sarah.chen@universal-logistics.example');
  if (coachPool.length === 0 || dispatcherPool.length === 0) {
    throw new Error('safety-comms: no fleet-manager/dispatcher/admin users found in the User table.');
  }

  // -------------------------------------------------------------------------------------------
  // Idempotent cleanup — own rows first (children via cascade, then this domain's own tables)
  // -------------------------------------------------------------------------------------------
  log('safety-comms: cleaning previous mock rows');
  const ownConversationIds = (
    await prisma.conversationParticipant.findMany({
      where: { driverId: { in: mockDriverIds } },
      select: { conversationId: true },
      distinct: ['conversationId'],
    })
  ).map((r) => r.conversationId);
  for (let i = 0; i < ownConversationIds.length; i += CHUNK) {
    await prisma.conversation.deleteMany({ where: { id: { in: ownConversationIds.slice(i, i + CHUNK) } } });
  }
  await prisma.notification.deleteMany({ where: { type: { in: NOTIFICATION_TYPES } } });
  await prisma.safetyEvent.deleteMany({ where: { OR: [{ driverId: { in: mockDriverIds } }, { vehicleId: { in: mockVehicleIds } }] } });
  await prisma.driverScore.deleteMany({ where: { driverId: { in: mockDriverIds } } });
  await prisma.supportTicket.deleteMany({ where: { number: { startsWith: MOCK_TICKET_PREFIX } } });
  await prisma.feedback.deleteMany({ where: { OR: [{ driverId: { in: mockDriverIds } }, { comment: { contains: MOCK_TAG } }] } });

  // -------------------------------------------------------------------------------------------
  // Location source: prefer real telemetry, then EldEvent driving fixes, then fallback routes
  // -------------------------------------------------------------------------------------------
  const telemetrySamples = await prisma.telemetryPoint.findMany({
    where: { vehicleId: { in: mockVehicleIds } },
    select: { vehicleId: true, latitude: true, longitude: true, speedMph: true },
    take: 5000,
  });
  let byVehicleLocations = new Map<string, Array<{ lat: number; lon: number; speedMph: number | null }>>();
  for (const t of telemetrySamples) {
    const arr = byVehicleLocations.get(t.vehicleId) ?? [];
    arr.push({ lat: Number(t.latitude), lon: Number(t.longitude), speedMph: t.speedMph });
    byVehicleLocations.set(t.vehicleId, arr);
  }
  let locationSource: 'telemetry' | 'eldevent' | 'fallback' = 'telemetry';
  if (byVehicleLocations.size === 0) {
    const eldEventFixes = await prisma.eldEvent.findMany({
      where: {
        driverId: { in: mockDriverIds },
        eventType: EVENT_TYPE.DUTY_STATUS_CHANGE,
        eventCode: DUTY_CODE.D,
        latitude: { not: null },
      },
      select: { vehicleId: true, latitude: true, longitude: true },
      take: 5000,
    });
    for (const e of eldEventFixes) {
      if (!e.vehicleId || e.latitude === null || e.longitude === null) continue;
      const arr = byVehicleLocations.get(e.vehicleId) ?? [];
      arr.push({ lat: Number(e.latitude), lon: Number(e.longitude), speedMph: null });
      byVehicleLocations.set(e.vehicleId, arr);
    }
    locationSource = byVehicleLocations.size > 0 ? 'eldevent' : 'fallback';
  }
  log(`safety-comms: location source = ${locationSource} (${byVehicleLocations.size} vehicles with real fixes)`);

  function locationFor(vehicleId: string): { lat: number; lon: number; name: string | null; ambientSpeedMph: number | null } {
    const pts = byVehicleLocations.get(vehicleId);
    if (pts && pts.length > 0) {
      const p = rng.pick(pts);
      return { lat: p.lat, lon: p.lon, name: null, ambientSpeedMph: p.speedMph };
    }
    const wp = rng.pick(FALLBACK_WAYPOINTS);
    return { lat: jitter(rng, wp.lat, 0.6), lon: jitter(rng, wp.lon, 0.6), name: wp.name, ambientSpeedMph: null };
  }
  function speedLimitFor(): number {
    return rng.pick([55, 60, 65, 70, 75]);
  }

  // -------------------------------------------------------------------------------------------
  // 1) Safety events — long-tail risk per driver, spread across the 6-month window
  // -------------------------------------------------------------------------------------------
  log('safety-comms: generating safety events');
  interface GenEvent {
    id: string;
    driverId: string;
    vehicleId: string;
    type: SafetyEventType;
    occurredAt: Date;
    severity: number;
    speedMph: number | null;
    speedLimitMph: number | null;
    gForce: number | null;
    latitude: number;
    longitude: number;
    locationName: string | null;
    durationSec: number | null;
    status: CoachingStatus;
    coachedById: string | null;
    coachedAt: Date | null;
    coachingNote: string | null;
  }
  const events: GenEvent[] = [];
  // Pinned to UTC (not the host's local zone) so calendar-day math (`.startOf('day')` etc.)
  // agrees with how `@db.Date` columns (DriverScore.periodStart/periodEnd) truncate on
  // write — B-056: computing these in the host's local zone shifted the stored date back a
  // day whenever the host ran ahead of UTC (e.g. CEST), breaking `/safety/scorecard`'s
  // exact-date match.
  const nowDt = DateTime.fromJSDate(to, { zone: 'utc' });
  const fromDt = DateTime.fromJSDate(from, { zone: 'utc' });
  const totalMonths = Math.max(1, Math.ceil(nowDt.diff(fromDt, 'months').months));

  for (const driver of drivers) {
    const risk = riskFactor(rng.next());
    const rates = ratesForRisk(risk);
    const vehicleId = driver.assignedVehicleId ?? rng.pick(mockVehicleIds);
    const hireDt = DateTime.fromJSDate(driver.registeredAt);
    // TERMINATED/INACTIVE drivers still drove for part of the window, just less recently/often.
    const activityMultiplier = driver.status === 'ACTIVE' ? 1 : driver.status === 'INACTIVE' ? 0.4 : 0.25;

    for (let m = 0; m < totalMonths; m++) {
      const monthStart = DateTime.max(fromDt.plus({ months: m }), hireDt);
      const monthEndRaw = fromDt.plus({ months: m + 1 });
      const monthEnd = DateTime.min(monthEndRaw, nowDt);
      if (monthEnd <= monthStart) continue;
      const spanDays = monthEnd.diff(monthStart, 'days').days;
      const monthFraction = activeDaysFraction(spanDays, 30.44);

      const typeCounts: Array<[SafetyEventType, number]> = [
        [SafetyEventType.HARSH_BRAKING, Math.round(rng.float(0.3, 1.6) * rates.harshPerMonth * 0.45 * monthFraction * activityMultiplier)],
        [SafetyEventType.HARSH_ACCEL, Math.round(rng.float(0.3, 1.6) * rates.harshPerMonth * 0.35 * monthFraction * activityMultiplier)],
        [SafetyEventType.HARSH_TURN, Math.round(rng.float(0.3, 1.6) * rates.harshPerMonth * 0.2 * monthFraction * activityMultiplier)],
        [SafetyEventType.SPEEDING, Math.round(rng.float(0.3, 1.6) * rates.speedingPerMonth * monthFraction * activityMultiplier)],
        [SafetyEventType.SEATBELT, Math.round(rng.float(0.2, 1.8) * rates.seatbeltPerMonth * monthFraction * activityMultiplier)],
      ];

      for (const [type, count] of typeCounts) {
        for (let i = 0; i < count; i++) {
          const spanMs = monthEnd.toMillis() - monthStart.toMillis();
          const occurredAt = clampToNow(new Date(monthStart.toMillis() + rng.float(0, 1) * spanMs), ctx);
          const loc = locationFor(vehicleId);
          const ageDays = Math.max(0, DateTime.fromJSDate(to).diff(DateTime.fromJSDate(occurredAt), 'days').days);
          const status = pickStatus(statusWeightsForAgeDays(ageDays), rng.next());

          let speedMph: number | null = null;
          let speedLimitMph: number | null = null;
          let severity = 1;
          let durationSec: number | null = null;
          let gForce: number | null = null;

          if (type === SafetyEventType.SPEEDING) {
            speedLimitMph = speedLimitFor();
            const over = Math.round(rng.float(6, 6 + risk * 20));
            speedMph = speedLimitMph + over;
            severity = severityFromDelta(over, 8);
            durationSec = rng.int(20, 300);
          } else if (type === SafetyEventType.SEATBELT) {
            durationSec = rng.int(30, 1800);
            severity = severityFromDelta(durationSec, 300);
          } else {
            speedMph = loc.ambientSpeedMph ?? rng.int(28, 68);
            const delta = rng.float(8, 8 + risk * 14);
            severity = severityFromDelta(delta, 8);
            gForce = Math.min(0.9, 0.3 + delta / 40);
            durationSec = rng.int(1, 4);
          }

          let coachedById: string | null = null;
          let coachedAt: Date | null = null;
          let coachingNote: string | null = null;
          if (status === 'COACHED') {
            // A COACHED event is "coaching assigned" the moment a coach is on it; it only
            // becomes "coaching completed" once `coachedAt`/`coachingNote` are actually filled
            // in (D-057). Recent assignments are realistically still open — the coach hasn't
            // gotten to the write-up yet — so skew "still pending" heavily for fresh events and
            // taper it down for older ones, leaving a small still-open backlog even at the tail.
            coachedById = rng.pick(coachPool).id;
            const pendingChance = ageDays <= 3 ? 0.7 : ageDays <= 14 ? 0.3 : 0.05;
            if (!rng.chance(pendingChance)) {
              coachedAt = clampToNow(
                DateTime.fromJSDate(occurredAt).plus({ days: rng.int(1, 10) }).toJSDate(),
                ctx,
              );
              const notes = COACHING_NOTES[type] ?? REVIEW_DISMISS_NOTES;
              coachingNote = rng.pick(notes);
            }
          }

          events.push({
            id: randomUUID(),
            driverId: driver.id,
            vehicleId,
            type,
            occurredAt,
            severity,
            speedMph,
            speedLimitMph,
            gForce,
            latitude: loc.lat,
            longitude: loc.lon,
            locationName: loc.name,
            durationSec,
            status,
            coachedById,
            coachedAt,
            coachingNote,
          });
        }
      }
    }
  }
  await createManyChunked(
    (rows) => prisma.safetyEvent.createMany({ data: rows as unknown as Prisma.SafetyEventCreateManyInput[] }),
    events,
  );
  const newRecentCount = events.filter(
    (e) => e.status === 'NEW' && DateTime.fromJSDate(to).diff(DateTime.fromJSDate(e.occurredAt), 'days').days <= 3,
  ).length;
  log(`safety-comms: ${events.length} safety events (${newRecentCount} NEW in the last 3 days)`);

  // -------------------------------------------------------------------------------------------
  // 2) Driver scores — one row per driver per calendar month, plus a trailing 30-day rolling one
  // -------------------------------------------------------------------------------------------
  log('safety-comms: computing driver scores');
  const dailyLogs = await prisma.dailyLog.findMany({
    where: { driverId: { in: mockDriverIds } },
    select: { driverId: true, logDate: true, totalDistanceMi: true, violationCount: true },
  });
  const violations = await prisma.hosViolation.findMany({
    where: { driverId: { in: mockDriverIds } },
    select: { driverId: true, occurredAt: true },
  });

  function milesAndViolationsFor(driverId: string, start: DateTime, end: DateTime): { miles: number; violationCount: number } {
    let miles = 0;
    let violationCount = 0;
    for (const dl of dailyLogs) {
      if (dl.driverId !== driverId) continue;
      const d = DateTime.fromJSDate(dl.logDate);
      if (d >= start && d < end) {
        miles += dl.totalDistanceMi;
        violationCount += dl.violationCount;
      }
    }
    if (miles === 0) {
      // hos.ts hasn't run yet (or this driver has no logs in-period) — synth a plausible figure
      // so the score isn't a divide-by-near-zero degenerate 0/100 for every mock driver.
      const spanDays = Math.max(1, end.diff(start, 'days').days);
      miles = Math.round(spanDays * 260); // ~260 mi/active-day is a typical OTR pace
    }
    if (violationCount === 0) {
      violationCount = violations.filter((v) => v.driverId === driverId && DateTime.fromJSDate(v.occurredAt) >= start && DateTime.fromJSDate(v.occurredAt) < end).length;
    }
    return { miles, violationCount };
  }

  interface ScoreRow {
    id: string;
    driverId: string;
    periodStart: Date;
    periodEnd: Date;
    score: number;
    harshCount: number;
    speedingCount: number;
    milesDriven: number;
    violationCount: number;
    rank: number | null;
  }
  const scoreRows: ScoreRow[] = [];
  const HARSH_TYPES = new Set<SafetyEventType>([SafetyEventType.HARSH_BRAKING, SafetyEventType.HARSH_ACCEL, SafetyEventType.HARSH_TURN]);

  const periods: Array<{ start: DateTime; end: DateTime }> = [];
  for (let m = 0; m < totalMonths; m++) {
    const start = fromDt.plus({ months: m }).startOf('day');
    const end = DateTime.min(fromDt.plus({ months: m + 1 }).startOf('day'), nowDt.startOf('day').plus({ days: 1 }));
    if (end > start) periods.push({ start, end });
  }
  // Trailing 30-day rolling period — matches the frontend's default `/safety/scorecard` call.
  periods.push({ start: nowDt.minus({ days: 30 }).startOf('day'), end: nowDt.startOf('day').plus({ days: 1 }) });

  for (const period of periods) {
    const perDriverScores: Array<{ driverId: string; score: number; harshCount: number; speedingCount: number; miles: number; violationCount: number }> = [];
    for (const driver of drivers) {
      const inPeriodEvents = events.filter(
        (e) => e.driverId === driver.id && DateTime.fromJSDate(e.occurredAt) >= period.start && DateTime.fromJSDate(e.occurredAt) < period.end,
      );
      const harshCount = inPeriodEvents.filter((e) => HARSH_TYPES.has(e.type)).length;
      const speedingCount = inPeriodEvents.filter((e) => e.type === SafetyEventType.SPEEDING).length;
      const { miles, violationCount } = milesAndViolationsFor(driver.id, period.start, period.end);
      const score = computeDriverScore({ harshCount, speedingCount, milesDriven: miles, violationCount });
      perDriverScores.push({ driverId: driver.id, score, harshCount, speedingCount, miles, violationCount });
    }
    perDriverScores.sort((a, b) => a.score - b.score);
    perDriverScores.forEach((s, idx) => {
      scoreRows.push({
        id: randomUUID(),
        driverId: s.driverId,
        periodStart: period.start.toJSDate(),
        periodEnd: DateTime.min(period.end.minus({ days: 1 }), nowDt).toJSDate(),
        score: s.score,
        harshCount: s.harshCount,
        speedingCount: s.speedingCount,
        milesDriven: s.miles,
        violationCount: s.violationCount,
        rank: idx + 1,
      });
    });
  }
  await createManyChunked(
    (rows) => prisma.driverScore.createMany({ data: rows as unknown as Prisma.DriverScoreCreateManyInput[] }),
    scoreRows,
  );
  log(`safety-comms: ${scoreRows.length} driver-score rows across ${periods.length} periods`);

  // -------------------------------------------------------------------------------------------
  // 3) Notifications for safety events (new-event + coaching) — kept close to real event volume
  // -------------------------------------------------------------------------------------------
  interface NotifRow {
    id: string;
    userId: string | null;
    driverId: string | null;
    type: string;
    title: string;
    body: string;
    objectType: string | null;
    objectId: string | null;
    readAt: Date | null;
    createdAt: Date;
  }
  const notifRows: NotifRow[] = [];
  for (const e of events) {
    const ageDays = DateTime.fromJSDate(to).diff(DateTime.fromJSDate(e.occurredAt), 'days').days;
    if (e.status === 'NEW' && ageDays <= 14) {
      const driver = drivers.find((d) => d.id === e.driverId);
      const recipientUserId = driver?.fleetManagerId ?? rng.pick(coachPool).id;
      notifRows.push({
        id: randomUUID(),
        userId: recipientUserId,
        driverId: null,
        type: 'safety.new_event',
        title: `New ${e.type.toLowerCase().replace('_', ' ')} event`,
        body: `A ${e.type.toLowerCase().replace('_', ' ')} event was flagged and needs review.`,
        objectType: 'SafetyEvent',
        objectId: e.id,
        readAt: rng.chance(0.4)
          ? readAtOrNull(DateTime.fromJSDate(e.occurredAt).plus({ hours: rng.int(1, 20) }).toJSDate(), e.occurredAt, ctx)
          : null,
        createdAt: e.occurredAt,
      });
    }
    if (e.status === 'COACHED' && e.coachedById) {
      // "Assigned" fires the moment a coach is attached to the event — true for BOTH the
      // still-open and the completed ones (a coach was assigned in either case). "Completed"
      // only fires once `coachedAt`/`coachingNote` are actually filled in — see the pending-vs-
      // completed split above, so open coaching never gets a false "completed" notification.
      const assignedAt = e.coachedAt ?? clampToNow(DateTime.fromJSDate(e.occurredAt).plus({ hours: rng.int(1, 12) }).toJSDate(), ctx);
      notifRows.push({
        id: randomUUID(),
        userId: e.coachedById,
        driverId: null,
        type: 'safety.coaching_assigned',
        title: 'Coaching assigned',
        body: `Coaching assigned for a ${e.type.toLowerCase().replace('_', ' ')} event.`,
        objectType: 'SafetyEvent',
        objectId: e.id,
        readAt: rng.chance(0.6) ? readAtOrNull(assignedAt, assignedAt, ctx) : null,
        createdAt: assignedAt,
      });
    }
    if (e.status === 'COACHED' && e.coachedAt && e.coachingNote) {
      notifRows.push({
        id: randomUUID(),
        userId: null,
        driverId: e.driverId,
        type: 'safety.coaching_completed',
        title: 'Coaching completed',
        body: e.coachingNote ?? 'Your safety coaching session has been completed.',
        objectType: 'SafetyEvent',
        objectId: e.id,
        readAt: rng.chance(0.5)
          ? readAtOrNull(DateTime.fromJSDate(e.coachedAt).plus({ hours: rng.int(1, 48) }).toJSDate(), e.coachedAt, ctx)
          : null,
        createdAt: e.coachedAt,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // 4) Messaging — direct, group, broadcast conversations with realistic bodies
  // -------------------------------------------------------------------------------------------
  log('safety-comms: generating conversations and messages');
  interface ConvoRow {
    id: string;
    type: ConversationType;
    title: string | null;
    createdById: string;
    createdAt: Date;
    lastMessageAt: Date | null;
  }
  interface ParticipantRow {
    id: string;
    conversationId: string;
    userId: string | null;
    driverId: string | null;
    lastReadAt: Date | null;
  }
  interface MessageRow {
    id: string;
    conversationId: string;
    senderUserId: string | null;
    senderDriverId: string | null;
    body: string;
    clientId: string;
    sentAt: Date;
  }
  const convoRows: ConvoRow[] = [];
  const participantRows: ParticipantRow[] = [];
  const messageRows: MessageRow[] = [];

  function fillTemplate(tpl: string, ctxVars: { unit: string; city: string; origin: string; dest: string }): string {
    const time = rng.pick(['6pm', '7pm', '8pm', '9pm', '10pm']);
    return tpl
      .replace('{unit}', ctxVars.unit)
      .replace('{city}', ctxVars.city)
      .replace('{origin}', ctxVars.origin)
      .replace('{dest}', ctxVars.dest)
      .replace('{time}', time);
  }

  function randomTimestampsAscending(count: number, start: DateTime, end: DateTime): Date[] {
    const spanMs = Math.max(1, end.toMillis() - start.toMillis());
    const ts = Array.from({ length: count }, () => start.toMillis() + rng.float(0, 1) * spanMs);
    ts.sort((a, b) => a - b);
    return ts.map((ms) => clampToNow(new Date(ms), ctx));
  }

  const activeMockDrivers = rng.shuffle(drivers.filter((d) => d.status === 'ACTIVE'));
  const directDriverCount = Math.round(activeMockDrivers.length * 0.65);

  // 4a) Direct conversations dispatcher <-> driver
  for (let i = 0; i < directDriverCount; i++) {
    const driver = activeMockDrivers[i];
    const dispatcher = i < 8 && sarahChen ? sarahChen : rng.pick(dispatcherPool);
    const unit = vehicles.find((v) => v.id === driver.assignedVehicleId)?.unitNumber ?? rng.pick(vehicles).unitNumber;
    const cityWp = rng.pick(FALLBACK_WAYPOINTS);
    const destWp = rng.pick(FALLBACK_WAYPOINTS);
    const vars = { unit, city: cityWp.name.split(' near ')[1] ?? cityWp.name, origin: cityWp.name, dest: destWp.name.split(' near ')[1] ?? destWp.name };

    const isRecent = i < 20; // guarantees "recent conversations" for the messaging screen
    const convStart = isRecent
      ? nowDt.minus({ days: rng.int(0, 3) })
      : fromDt.plus({ days: rng.int(0, Math.max(1, nowDt.diff(fromDt, 'days').days - 5)) });
    const msgCount = rng.int(2, 12);
    const timestamps = randomTimestampsAscending(msgCount, convStart, DateTime.min(convStart.plus({ days: rng.int(1, 14) }), nowDt));

    const convoId = randomUUID();
    convoRows.push({
      id: convoId,
      type: ConversationType.DIRECT,
      title: null,
      createdById: dispatcher.id,
      createdAt: timestamps[0],
      lastMessageAt: timestamps[timestamps.length - 1],
    });
    const dispatcherUnread = rng.chance(0.3);
    participantRows.push({
      id: randomUUID(),
      conversationId: convoId,
      userId: dispatcher.id,
      driverId: null,
      lastReadAt: dispatcherUnread ? (timestamps.length > 1 ? timestamps[timestamps.length - 2] : null) : timestamps[timestamps.length - 1],
    });
    participantRows.push({
      id: randomUUID(),
      conversationId: convoId,
      userId: null,
      driverId: driver.id,
      lastReadAt: rng.chance(0.8) ? timestamps[timestamps.length - 1] : timestamps[Math.max(0, timestamps.length - 2)],
    });
    for (let j = 0; j < timestamps.length; j++) {
      const fromDispatcher = j % 2 === 0;
      const body = fillTemplate(rng.pick(fromDispatcher ? DISPATCH_TO_DRIVER : DRIVER_TO_DISPATCH), vars);
      messageRows.push({
        id: randomUUID(),
        conversationId: convoId,
        senderUserId: fromDispatcher ? dispatcher.id : null,
        senderDriverId: fromDispatcher ? null : driver.id,
        body,
        clientId: `mock_msg_${randomUUID()}`,
        sentAt: timestamps[j],
      });
    }
  }

  // 4b) Group conversations — one dispatcher (or sarah.chen) + a handful of drivers
  const groupPool = rng.shuffle(activeMockDrivers.slice(directDriverCount));
  let groupCursor = 0;
  for (let g = 0; g < GROUP_TITLES.length && groupCursor < groupPool.length; g++) {
    const size = Math.min(rng.int(6, 14), groupPool.length - groupCursor);
    if (size <= 0) break;
    const members = groupPool.slice(groupCursor, groupCursor + size);
    groupCursor += size;
    const dispatcher = g === 0 && sarahChen ? sarahChen : rng.pick(dispatcherPool);
    const isRecent = g < 3;
    const convStart = isRecent ? nowDt.minus({ days: rng.int(0, 5) }) : fromDt.plus({ days: rng.int(0, 150) });
    const msgCount = rng.int(3, 8);
    const timestamps = randomTimestampsAscending(msgCount, convStart, DateTime.min(convStart.plus({ days: 10 }), nowDt));

    const convoId = randomUUID();
    convoRows.push({
      id: convoId,
      type: ConversationType.GROUP,
      title: GROUP_TITLES[g],
      createdById: dispatcher.id,
      createdAt: timestamps[0],
      lastMessageAt: timestamps[timestamps.length - 1],
    });
    participantRows.push({
      id: randomUUID(),
      conversationId: convoId,
      userId: dispatcher.id,
      driverId: null,
      lastReadAt: rng.chance(0.35) ? null : timestamps[timestamps.length - 1],
    });
    for (const member of members) {
      participantRows.push({
        id: randomUUID(),
        conversationId: convoId,
        userId: null,
        driverId: member.id,
        lastReadAt: rng.chance(0.7) ? timestamps[timestamps.length - 1] : null,
      });
    }
    for (let j = 0; j < timestamps.length; j++) {
      const fromDispatcherMsg = j === 0 || rng.chance(0.6);
      messageRows.push({
        id: randomUUID(),
        conversationId: convoId,
        senderUserId: fromDispatcherMsg ? dispatcher.id : null,
        senderDriverId: fromDispatcherMsg ? null : rng.pick(members).id,
        body: fromDispatcherMsg ? rng.pick(GROUP_MESSAGES) : rng.pick(DRIVER_TO_DISPATCH).replace(/{[a-z]+}/g, 'the terminal'),
        clientId: `mock_msg_${randomUUID()}`,
        sentAt: timestamps[j],
      });
    }
  }

  // 4c) Broadcasts — mirrors MessagingService.broadcast(): one BROADCAST conversation per
  // recipient driver, each with exactly one message from the sender.
  for (let b = 0; b < BROADCAST_TITLES_BODIES.length; b++) {
    const { title, body } = BROADCAST_TITLES_BODIES[b];
    const sender = b % 3 === 0 && sarahChen ? sarahChen : rng.pick(dispatcherPool);
    const recipients = rng.shuffle(drivers).slice(0, rng.int(10, 35));
    const isRecent = b < 3;
    const sentAt = clampToNow(
      (isRecent ? nowDt.minus({ days: rng.int(0, 4) }) : fromDt.plus({ days: rng.int(0, 170) })).toJSDate(),
      ctx,
    );
    for (const driver of recipients) {
      const convoId = randomUUID();
      convoRows.push({
        id: convoId,
        type: ConversationType.BROADCAST,
        title,
        createdById: sender.id,
        createdAt: sentAt,
        lastMessageAt: sentAt,
      });
      participantRows.push({
        id: randomUUID(),
        conversationId: convoId,
        userId: sender.id,
        driverId: null,
        lastReadAt: sentAt,
      });
      participantRows.push({
        id: randomUUID(),
        conversationId: convoId,
        userId: null,
        driverId: driver.id,
        lastReadAt: rng.chance(0.5) ? sentAt : null,
      });
      messageRows.push({
        id: randomUUID(),
        conversationId: convoId,
        senderUserId: sender.id,
        senderDriverId: null,
        body,
        clientId: `mock_msg_${randomUUID()}`,
        sentAt,
      });
    }
  }

  await createManyChunked((rows) => prisma.conversation.createMany({ data: rows as unknown as Prisma.ConversationCreateManyInput[] }), convoRows);
  await createManyChunked(
    (rows) => prisma.conversationParticipant.createMany({ data: rows as unknown as Prisma.ConversationParticipantCreateManyInput[] }),
    participantRows,
  );
  await createManyChunked((rows) => prisma.message.createMany({ data: rows as unknown as Prisma.MessageCreateManyInput[] }), messageRows);
  log(`safety-comms: ${convoRows.length} conversations, ${participantRows.length} participants, ${messageRows.length} messages`);

  // Message notifications — one per message to each other participant (kept modest: direct=1,
  // group=capped, broadcast=1), so the notification bell has realistic, non-explosive volume.
  const convoParticipantsById = new Map<string, ParticipantRow[]>();
  for (const p of participantRows) {
    const arr = convoParticipantsById.get(p.conversationId) ?? [];
    arr.push(p);
    convoParticipantsById.set(p.conversationId, arr);
  }
  for (const m of messageRows) {
    const participants = convoParticipantsById.get(m.conversationId) ?? [];
    const others = participants.filter((p) => (m.senderUserId ? p.userId !== m.senderUserId : p.driverId !== m.senderDriverId)).slice(0, 5);
    for (const other of others) {
      notifRows.push({
        id: randomUUID(),
        userId: other.userId,
        driverId: other.driverId,
        type: 'message.new',
        title: 'New message',
        body: m.body.length > 140 ? `${m.body.slice(0, 137)}...` : m.body,
        objectType: 'Conversation',
        objectId: m.conversationId,
        readAt: other.lastReadAt && other.lastReadAt >= m.sentAt ? other.lastReadAt : null,
        createdAt: m.sentAt,
      });
    }
  }
  await createManyChunked((rows) => prisma.notification.createMany({ data: rows as unknown as Prisma.NotificationCreateManyInput[] }), notifRows);
  log(`safety-comms: ${notifRows.length} notifications`);

  // -------------------------------------------------------------------------------------------
  // 5) Support tickets — every status x priority, with simulated reply threads in `body`
  //    (schema has no separate ticket-reply model — see decisions.md).
  // -------------------------------------------------------------------------------------------
  log('safety-comms: generating support tickets and feedback');
  const allStatuses = [TicketStatus.OPEN, TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED, TicketStatus.CLOSED];
  const allPriorities = [TicketPriority.LOW, TicketPriority.NORMAL, TicketPriority.HIGH, TicketPriority.URGENT];
  interface TicketRow {
    id: string;
    number: string;
    subject: string;
    body: string;
    category: string;
    priority: TicketPriority;
    status: TicketStatus;
    createdByUserId: string | null;
    createdByDriverId: string | null;
    assignedToId: string | null;
    createdAt: Date;
    resolvedAt: Date | null;
  }
  const ticketRows: TicketRow[] = [];
  let ticketSeq = 1;
  const TICKETS_PER_COMBO = 3;
  for (const status of allStatuses) {
    for (const priority of allPriorities) {
      for (let i = 0; i < TICKETS_PER_COMBO; i++) {
        const tpl = rng.pick(TICKET_TEMPLATES);
        const createdAt = fromDt.plus({ days: rng.int(0, Math.max(1, nowDt.diff(fromDt, 'days').days - 1)) }).toJSDate();
        const isDriverCreated = rng.chance(0.75);
        const driver = isDriverCreated ? rng.pick(drivers) : null;
        const creatorUser = isDriverCreated ? null : rng.pick(dispatcherPool.concat(coachPool));
        const assignedToId = status === TicketStatus.OPEN ? null : rng.pick(coachPool.concat(dispatcherPool)).id;
        const replies = TICKET_REPLIES[status];
        const resolvedAt =
          status === TicketStatus.RESOLVED || status === TicketStatus.CLOSED
            ? clampToNow(DateTime.fromJSDate(createdAt).plus({ hours: rng.int(2, 96) }).toJSDate(), ctx)
            : null;
        ticketRows.push({
          id: randomUUID(),
          number: `${MOCK_TICKET_PREFIX}${(ticketSeq++).toString().padStart(6, '0')}`,
          subject: tpl.subject,
          body: `${tpl.body} [mock]${replies.join('')}`,
          category: tpl.category,
          priority,
          status,
          createdByUserId: creatorUser?.id ?? null,
          createdByDriverId: driver?.id ?? null,
          assignedToId,
          createdAt,
          resolvedAt,
        });
      }
    }
  }
  await createManyChunked((rows) => prisma.supportTicket.createMany({ data: rows as unknown as Prisma.SupportTicketCreateManyInput[] }), ticketRows);

  // -------------------------------------------------------------------------------------------
  // 6) Feedback
  // -------------------------------------------------------------------------------------------
  interface FeedbackRow {
    id: string;
    driverId: string | null;
    userId: string | null;
    answers: Prisma.InputJsonValue;
    comment: string | null;
    appVersion: string | null;
    platform: string | null;
    createdAt: Date;
  }
  const feedbackRows: FeedbackRow[] = [];
  const FEEDBACK_COUNT = 150;
  for (let i = 0; i < FEEDBACK_COUNT; i++) {
    const isDriver = rng.chance(0.85);
    const driver = isDriver ? rng.pick(drivers) : null;
    const user = isDriver ? null : rng.pick(dispatcherPool.concat(coachPool));
    const comment = rng.pick(FEEDBACK_COMMENTS);
    feedbackRows.push({
      id: randomUUID(),
      driverId: driver?.id ?? null,
      userId: user?.id ?? null,
      answers: { appRating: rng.int(2, 5), easeOfUse: rng.int(2, 5), wouldRecommend: rng.chance(0.75) },
      comment: comment ? `${comment} [${MOCK_TAG}]` : null,
      appVersion: rng.pick(['3.4.0', '3.5.2', '3.6.0', '3.6.1']),
      platform: rng.chance(0.6) ? 'ANDROID' : 'IOS',
      createdAt: fromDt.plus({ days: rng.int(0, Math.max(1, nowDt.diff(fromDt, 'days').days - 1)) }).toJSDate(),
    });
  }
  await createManyChunked((rows) => prisma.feedback.createMany({ data: rows as unknown as Prisma.FeedbackCreateManyInput[] }), feedbackRows);

  log(
    `safety-comms: done — ${events.length} safety events, ${scoreRows.length} scores, ${convoRows.length} conversations, ` +
      `${messageRows.length} messages, ${notifRows.length} notifications, ${ticketRows.length} tickets, ${feedbackRows.length} feedback`,
  );

  return {
    safetyEvents: events.length,
    driverScores: scoreRows.length,
    conversations: convoRows.length,
    messages: messageRows.length,
    notifications: notifRows.length,
    supportTickets: ticketRows.length,
    feedback: feedbackRows.length,
  };
}
