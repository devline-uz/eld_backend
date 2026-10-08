/**
 * Maps persisted §395 rows onto the Appendix A output-file input (tz.md §10.2).
 *
 * Pure and Prisma-typed-but-not-Prisma-bound, so the mapping rules (which record lands in
 * which segment, how order numbers are assigned) are unit-testable without a database.
 */
import type { Carrier, DailyLog, Driver, EldEvent, User, Vehicle } from '@prisma/client';
import { offsetMs } from '../hos/engine/timezone';
import type {
  OutputFileAnnotation,
  OutputFileCertification,
  OutputFileCmv,
  OutputFileEvent,
  OutputFileInput,
  OutputFileUser,
} from './output-file';

/** §395 event types (tz.md §7): 1 duty status · 4 certification · 7 malfunction/diagnostic. */
export const EVENT_TYPE = { DUTY_STATUS: 1, INTERMEDIATE: 2, PC_YM: 3, CERTIFICATION: 4, LOGIN: 5, POWER: 6, MALFUNCTION: 7 } as const;

export interface SnapshotInput {
  driver: Driver;
  carrier: Carrier;
  /** Every record for the driver in the range, active or not. */
  events: EldEvent[];
  /** Unidentified driving records (`recordOrigin = 4`) in the range. */
  unidentifiedEvents: EldEvent[];
  vehicles: Vehicle[];
  /** Back-office users that appear as `editedById` on any record in the range. */
  users: User[];
  dailyLogs: DailyLog[];
  outputFileComment: string;
  generatedAt: Date;
  eldIdentifier: string;
  eldRegistrationId: string;
  eldAuthenticationValue: string;
  coDriver?: Driver | null;
  shippingDocumentNumber?: string;
}

/** 60/7 rulesets use a 7-day multiday basis, 70/8 rulesets use 8 (Appendix A header). */
export function multidayBasisOf(driver: Driver): 7 | 8 {
  return driver.hosRuleset === 'US_60_7_PROPERTY' || driver.hosRuleset === 'US_60_7_PASSENGER' ? 7 : 8;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildSnapshot(input: SnapshotInput): OutputFileInput {
  const { driver, carrier } = input;
  const timezone = driver.homeTerminalTimezone;
  const headerOffsetMin = Math.round(offsetMs(timezone, input.generatedAt) / 60_000);

  // --- user list: the driver is always order 1; editors follow in first-seen order --------
  const users: OutputFileUser[] = [
    {
      orderNumber: 1,
      username: driver.username,
      lastName: driver.lastName,
      firstName: driver.firstName,
      accountType: 'D',
    },
  ];
  const userOrder = new Map<string, number>([[driver.id, 1]]);
  const userById = new Map(input.users.map((u) => [u.id, u]));
  for (const e of input.events) {
    const editorId = e.editedById;
    if (!editorId || userOrder.has(editorId)) continue;
    const u = userById.get(editorId);
    const orderNumber = users.length + 1;
    userOrder.set(editorId, orderNumber);
    users.push({
      orderNumber,
      username: u?.email ?? editorId,
      lastName: u?.lastName ?? '',
      firstName: u?.firstName ?? '',
      // Appendix A ELD Account Type: `D` driver, `S` support personnel. A driver self-edit
      // (recordOrigin 2) keeps the driver's own order number, so anything else is support.
      accountType: 'S',
    });
  }

  // --- CMV list: distinct power units in first-seen order --------------------------------
  const cmvs: OutputFileCmv[] = [];
  const cmvOrder = new Map<string, number>();
  const vehicleById = new Map(input.vehicles.map((v) => [v.id, v]));
  for (const e of [...input.events, ...input.unidentifiedEvents]) {
    if (!e.vehicleId || cmvOrder.has(e.vehicleId)) continue;
    const v = vehicleById.get(e.vehicleId);
    const orderNumber = cmvs.length + 1;
    cmvOrder.set(e.vehicleId, orderNumber);
    cmvs.push({ orderNumber, powerUnitNumber: v?.unitNumber ?? e.vehicleId, vin: v?.vin ?? '' });
  }

  const positioningMalfunctionAt = positioningMalfunctionTimeline(input.events);

  const toOutputEvent = (e: EldEvent): OutputFileEvent => ({
    sequenceId: e.eventSequenceId,
    recordStatus: e.recordStatus,
    recordOrigin: e.recordOrigin,
    eventType: e.eventType,
    eventCode: e.eventCode,
    dateTime: e.eventDateTime,
    timezoneOffsetMin: e.timezoneOffset ?? headerOffsetMin,
    totalVehicleMiles: e.totalVehicleMiles ?? null,
    totalEngineHours: toNumber(e.totalEngineHours),
    latitude: toNumber(e.latitude),
    longitude: toNumber(e.longitude),
    locationPrecisionMi: e.locationPrecisionMi,
    distanceSinceLastValidCoords: e.distanceSinceLastValidCoords ?? null,
    cmvOrderNumber: e.vehicleId ? cmvOrder.get(e.vehicleId) ?? null : null,
    userOrderNumber: e.editedById ? userOrder.get(e.editedById) ?? 1 : 1,
    malfunctionIndicator: Boolean(e.malfunctionCode),
    diagnosticIndicator: Boolean(e.diagnosticCode),
    malfunctionCode: e.malfunctionCode,
    diagnosticCode: e.diagnosticCode,
    locationDescription: manualLocationDescription(e),
    positioningMalfunction: positioningMalfunctionAt(e.eventDateTime),
  });

  const events: OutputFileEvent[] = [];
  const malfunctions: OutputFileEvent[] = [];
  const certifications: OutputFileCertification[] = [];
  const annotations: OutputFileAnnotation[] = [];

  for (const e of input.events) {
    const mapped = toOutputEvent(e);
    if (e.eventType === EVENT_TYPE.MALFUNCTION) {
      malfunctions.push(mapped);
    } else if (e.eventType === EVENT_TYPE.CERTIFICATION) {
      certifications.push({
        sequenceId: e.eventSequenceId,
        eventCode: e.eventCode,
        dateTime: e.eventDateTime,
        timezoneOffsetMin: mapped.timezoneOffsetMin,
        // A certification record certifies the RODS day it was recorded on.
        certifiedDate: certifiedDateOf(e, mapped.timezoneOffsetMin),
      });
    } else {
      events.push(mapped);
    }
    const text = e.annotation ?? e.comment ?? e.editReason;
    // Appendix A 4.8.2.1.6: the Driver's Location Description lives in the annotation
    // segment, so a manually located record gets a row even when it carries no comment.
    if (text || mapped.locationDescription) {
      annotations.push({
        sequenceId: e.eventSequenceId,
        userOrderNumber: mapped.userOrderNumber,
        text: text ?? '',
        dateTime: e.eventDateTime,
        timezoneOffsetMin: mapped.timezoneOffsetMin,
        locationDescription: mapped.locationDescription,
      });
    }
  }

  const currentVehicle =
    [...input.events].reverse().map((e) => (e.vehicleId ? vehicleById.get(e.vehicleId) : undefined)).find(Boolean) ??
    (driver.assignedVehicleId ? vehicleById.get(driver.assignedVehicleId) : undefined);

  return {
    driver: {
      lastName: driver.lastName,
      firstName: driver.firstName,
      username: driver.username,
      licenseState: driver.cdlState,
      licenseNumber: driver.cdlNumber,
      multidayBasis: multidayBasisOf(driver),
      exempt: driver.eldExempt,
      timezoneOffsetMin: headerOffsetMin,
    },
    coDriver: input.coDriver
      ? {
          lastName: input.coDriver.lastName,
          firstName: input.coDriver.firstName,
          username: input.coDriver.username,
        }
      : null,
    currentCmv: {
      powerUnitNumber: currentVehicle?.unitNumber ?? '',
      vin: currentVehicle?.vin ?? '',
      trailerNumbers: '',
    },
    shippingDocumentNumber: input.shippingDocumentNumber ?? '',
    carrier: { usdotNumber: carrier.dotNumber, name: carrier.name },
    eldIdentifier: input.eldIdentifier,
    eldRegistrationId: input.eldRegistrationId,
    eldAuthenticationValue: input.eldAuthenticationValue,
    outputFileComment: input.outputFileComment,
    generatedAt: input.generatedAt,
    users,
    cmvs,
    malfunctions,
    events,
    annotations,
    certifications,
    unidentified: input.unidentifiedEvents.map(toOutputEvent),
  };
}

/**
 * Appendix A 4.3.2.7 — a location is "manually entered" when the record has a driver-typed
 * `locationName` but no valid position (MR-6, D-116). A `locationName` stored NEXT TO a
 * lat/lon pair is a reverse-geocode label, not a manual entry, and is not exported here.
 */
export function manualLocationDescription(e: EldEvent): string | null {
  const name = (e.locationName ?? '').trim();
  if (!name) return null;
  const hasPosition = toNumber(e.latitude) !== null && toNumber(e.longitude) !== null;
  return hasPosition ? null : name;
}

/**
 * Appendix A 4.6.1.4(c) — whether a positioning compliance malfunction (`L`, eventType 7
 * code 1, cleared by code 2) was active at a given instant. Only malfunction records inside
 * the exported range are visible here; an `L` set before the range start is not seen.
 */
export function positioningMalfunctionTimeline(events: EldEvent[]): (at: Date) => boolean {
  const changes = events
    .filter((e) => e.eventType === EVENT_TYPE.MALFUNCTION && e.malfunctionCode === 'L' && e.recordStatus === 1)
    .filter((e) => e.eventCode === 1 || e.eventCode === 2)
    .map((e) => ({ at: e.eventDateTime.getTime(), on: e.eventCode === 1 }))
    .sort((a, b) => a.at - b.at);
  return (at: Date): boolean => {
    let on = false;
    for (const c of changes) {
      if (c.at > at.getTime()) break;
      on = c.on;
    }
    return on;
  };
}

/** The RODS day a certification record belongs to, in home-terminal time. */
function certifiedDateOf(e: EldEvent, offsetMin: number): Date {
  const local = new Date(e.eventDateTime.getTime() + offsetMin * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** §10.3 — days in the range whose `DailyLog.certified` is false (warning, never blocking). */
export function uncertifiedDayCount(dailyLogs: DailyLog[], dayCount: number): number {
  const certified = dailyLogs.filter((l) => l.certified).length;
  return Math.max(0, dayCount - certified);
}

/**
 * §10.3 — malfunction codes logged (eventType 7, code 1) with no later clear (code 2).
 * Diagnostics (codes 3/4) are tracked the same way but are not a §10.3 warning on their own.
 */
export function activeMalfunctionCodes(events: EldEvent[]): string[] {
  const active = new Map<string, boolean>();
  for (const e of events.filter((x) => x.eventType === EVENT_TYPE.MALFUNCTION)) {
    const code = e.malfunctionCode;
    if (!code) continue;
    if (e.eventCode === 1) active.set(code, true);
    if (e.eventCode === 2) active.set(code, false);
  }
  return [...active.entries()].filter(([, on]) => on).map(([code]) => code);
}
