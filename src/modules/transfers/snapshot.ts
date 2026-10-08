/**
 * Maps persisted §395 rows onto the Appendix A output-file input (tz.md §10.2).
 *
 * Pure and Prisma-typed-but-not-Prisma-bound, so the mapping rules (which record lands in
 * which segment, how order numbers are assigned) are unit-testable without a database.
 * Section numbers below are 49 CFR §395 Subpart B Appendix A (`docs/fmcsa/`).
 */
import type { Carrier, DailyLog, Driver, EldEvent, User, Vehicle } from '@prisma/client';
import { dayKey, offsetMs } from '../hos/engine/timezone';
import type {
  OutputFileAnnotation,
  OutputFileCertification,
  OutputFileCmv,
  OutputFileCurrent,
  OutputFileEvent,
  OutputFileInput,
  OutputFileUser,
} from './output-file';
import { UNIDENTIFIED_PROFILE } from './segments';

/** §395 event types (Appendix A Table 9 / tz.md §7). */
export const EVENT_TYPE = { DUTY_STATUS: 1, INTERMEDIATE: 2, PC_YM: 3, CERTIFICATION: 4, LOGIN: 5, POWER: 6, MALFUNCTION: 7 } as const;

/** Appendix A Table 6 — engine power-up codes (conventional / reduced location precision). */
const POWER_UP_CODES = [1, 2];

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
  /** Explicit header Shipping Document Number; wins over `currentTripDetails` when set. */
  shippingDocumentNumber?: string;
  /**
   * D-129 — trailers / shipping documents in force at file generation (trips of that RODS day
   * merged with the driver's day details): header lines 3 and 4 (4.8.2.1.1, 7.42 / 7.39).
   */
  currentTripDetails?: TripDetails | null;
  /** D-129 — the same per home-terminal RODS day (`YYYY-MM-DD`), for engine power rows (4.8.2.1.9). */
  tripDetailsByDay?: Record<string, TripDetails>;
}

/** D-129 — trailer numbers / shipping documents of a RODS day (trips + day details). */
export interface TripDetails {
  trailerNumbers: string[];
  shippingDocuments: string[];
}

/** Appendix A 7.42 — Trailer Number(s): space-separated, max 32 chars; only whole numbers are kept. */
export const TRAILER_FIELD_MAX = 32;
/** Appendix A 7.39 — Shipping Document Number: max 40 chars. */
export const SHIPPING_DOCUMENT_FIELD_MAX = 40;

/**
 * Joins values with single spaces without ever cutting one in half: values that would push the
 * field past `max` are dropped (a lone over-long first value is truncated so the field is never
 * blank when something was entered).
 */
function joinWithin(values: string[], max: number): string {
  let out = '';
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, ' ');
    if (!value) continue;
    const next = out ? `${out} ${value}` : value;
    if (next.length <= max) out = next;
    else if (!out) return value.slice(0, max);
  }
  return out;
}

/** Appendix A 7.42 — `{BX987 POP712 10567}`. */
export function formatTrailerField(numbers: string[]): string {
  return joinWithin(numbers, TRAILER_FIELD_MAX);
}

/** Appendix A 7.39 — several documents of one day share the single 0-40 char field, space-separated. */
export function formatShippingDocumentField(documents: string[]): string {
  return joinWithin(documents, SHIPPING_DOCUMENT_FIELD_MAX);
}

/** 60/7 rulesets use a 7-day multiday basis, 70/8 rulesets use 8 (Appendix A 7.36). */
export function multidayBasisOf(driver: Driver): 7 | 8 {
  return driver.hosRuleset === 'US_60_7_PROPERTY' || driver.hosRuleset === 'US_60_7_PASSENGER' ? 7 : 8;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const byTimeDesc = (a: EldEvent, b: EldEvent): number => b.eventDateTime.getTime() - a.eventDateTime.getTime();

export function buildSnapshot(input: SnapshotInput): OutputFileInput {
  const { driver, carrier } = input;
  const timezone = driver.homeTerminalTimezone;
  const headerOffsetMin = Math.round(offsetMs(timezone, input.generatedAt) / 60_000);
  const allRecords = [...input.events, ...input.unidentifiedEvents];

  // --- 4.8.2.1.2 user list ----------------------------------------------------------------
  // Most recent user on top: the inspected driver (the one the file is produced for), then the
  // co-driver, then support personnel and the unidentified profile by their latest activity.
  const userById = new Map(input.users.map((u) => [u.id, u]));
  const usernameById = new Map<string, string>([[driver.id, driver.username]]);
  const lastEditAt = new Map<string, number>();
  for (const e of input.events) {
    const editorId = e.editedById;
    if (!editorId || editorId === driver.id) continue;
    lastEditAt.set(editorId, Math.max(lastEditAt.get(editorId) ?? 0, e.eventDateTime.getTime()));
    usernameById.set(editorId, userById.get(editorId)?.email ?? editorId);
  }
  type Ranked = { key: string; at: number; user: Omit<OutputFileUser, 'orderNumber'> };
  const ranked: Ranked[] = [...lastEditAt.entries()].map(([id, at]) => {
    const u = userById.get(id);
    return {
      key: id,
      at,
      // 7.13: `S` = motor carrier's support personnel. A driver self-edit keeps the driver's
      // own order number, so every other editor is support personnel.
      user: { username: u?.email ?? id, lastName: u?.lastName ?? '', firstName: u?.firstName ?? '', accountType: 'S' },
    };
  });
  const lastUnidentifiedAt = Math.max(0, ...input.unidentifiedEvents.map((e) => e.eventDateTime.getTime()));
  // 4.8.2.1.2 / 4.1.5 / 7.13 — the unidentified driver profile is ALWAYS listed, type `D`.
  ranked.push({ key: UNIDENTIFIED_KEY, at: lastUnidentifiedAt, user: { ...UNIDENTIFIED_PROFILE } });
  ranked.sort((a, b) => b.at - a.at);

  const head: { key: string; user: Omit<OutputFileUser, 'orderNumber'> }[] = [
    { key: driver.id, user: { username: driver.username, lastName: driver.lastName, firstName: driver.firstName, accountType: 'D' } },
  ];
  if (input.coDriver) {
    head.push({
      key: input.coDriver.id,
      user: { username: input.coDriver.username, lastName: input.coDriver.lastName, firstName: input.coDriver.firstName, accountType: 'D' },
    });
  }
  const userOrder = new Map<string, number>();
  const users: OutputFileUser[] = [];
  for (const { key, user } of [...head, ...ranked]) {
    if (userOrder.has(key)) continue;
    userOrder.set(key, users.length + 1);
    users.push({ orderNumber: users.length + 1, ...user });
  }

  // --- 4.8.2.1.3 CMV list: most recently operated CMV on top -----------------------------
  const cmvs: OutputFileCmv[] = [];
  const cmvOrder = new Map<string, number>();
  const vehicleById = new Map(input.vehicles.map((v) => [v.id, v]));
  for (const e of [...allRecords].sort(byTimeDesc)) {
    if (!e.vehicleId || cmvOrder.has(e.vehicleId)) continue;
    const v = vehicleById.get(e.vehicleId);
    const orderNumber = cmvs.length + 1;
    cmvOrder.set(e.vehicleId, orderNumber);
    cmvs.push({ orderNumber, powerUnitNumber: v?.unitNumber ?? e.vehicleId, vin: v?.vin ?? '' });
  }

  const positioningMalfunctionAt = positioningMalfunctionTimeline(input.events);
  const malfunctionActiveAt = indicatorTimeline(input.events, 1, 2);
  const diagnosticActiveAt = indicatorTimeline(input.events, 3, 4);
  const sinceLastPowerUp = powerUpBaseline(allRecords);

  const toOutputEvent = (e: EldEvent): OutputFileEvent => {
    const totalVehicleMiles = e.totalVehicleMiles ?? null;
    const totalEngineHours = toNumber(e.totalEngineHours);
    const baseline = sinceLastPowerUp(e);
    return {
      sequenceId: e.eventSequenceId,
      recordStatus: e.recordStatus,
      recordOrigin: e.recordOrigin,
      eventType: e.eventType,
      eventCode: e.eventCode,
      dateTime: e.eventDateTime,
      timezoneOffsetMin: e.timezoneOffset ?? headerOffsetMin,
      totalVehicleMiles,
      totalEngineHours,
      accumulatedVehicleMiles: difference(totalVehicleMiles, baseline?.miles ?? null, 0),
      elapsedEngineHours: difference(totalEngineHours, baseline?.hours ?? null, 1),
      latitude: toNumber(e.latitude),
      longitude: toNumber(e.longitude),
      locationPrecisionMi: e.locationPrecisionMi,
      distanceSinceLastValidCoords: e.distanceSinceLastValidCoords ?? null,
      cmvOrderNumber: e.vehicleId ? cmvOrder.get(e.vehicleId) ?? null : null,
      userOrderNumber: e.editedById ? userOrder.get(e.editedById) ?? 1 : 1,
      // 7.35 / 7.7 — "at least one active" malfunction / diagnostic at the record's time.
      malfunctionIndicator: Boolean(e.malfunctionCode) || malfunctionActiveAt(e.eventDateTime),
      diagnosticIndicator: Boolean(e.diagnosticCode) || diagnosticActiveAt(e.eventDateTime),
      malfunctionCode: e.malfunctionCode,
      diagnosticCode: e.diagnosticCode,
      locationDescription: manualLocationDescription(e),
      positioningMalfunction: positioningMalfunctionAt(e.eventDateTime),
      // 4.8.2.1.9 — engine power rows carry the trailers / shipping documents of their RODS day (D-129).
      ...(e.eventType === EVENT_TYPE.POWER && input.tripDetailsByDay
        ? powerRowTripFields(input.tripDetailsByDay[dayKey(timezone, e.eventDateTime)])
        : {}),
    };
  };

  const events: OutputFileEvent[] = [];
  const malfunctions: OutputFileEvent[] = [];
  const loginLogout: OutputFileEvent[] = [];
  const enginePower: OutputFileEvent[] = [];
  const certifications: OutputFileCertification[] = [];
  const annotations: OutputFileAnnotation[] = [];

  for (const e of input.events) {
    const mapped = toOutputEvent(e);
    switch (e.eventType) {
      case EVENT_TYPE.MALFUNCTION:
        malfunctions.push(mapped);
        continue;
      case EVENT_TYPE.LOGIN:
        loginLogout.push(mapped);
        continue;
      case EVENT_TYPE.POWER:
        enginePower.push(mapped);
        continue;
      case EVENT_TYPE.CERTIFICATION:
        certifications.push({
          sequenceId: e.eventSequenceId,
          eventCode: e.eventCode,
          dateTime: e.eventDateTime,
          timezoneOffsetMin: mapped.timezoneOffsetMin,
          certifiedDate: certifiedDateOf(e, mapped.timezoneOffsetMin),
          cmvOrderNumber: mapped.cmvOrderNumber,
        });
        continue;
      default:
        events.push(mapped);
    }
    // 4.8.2.1.5 — ONLY event-list records (types 1/2/3) with an annotation, comment or a
    // manual location description; the 2nd column is the record originator's ELD username.
    const text = e.annotation ?? e.comment ?? e.editReason;
    if (text || mapped.locationDescription) {
      annotations.push({
        sequenceId: e.eventSequenceId,
        username: (e.editedById ? usernameById.get(e.editedById) : undefined) ?? driver.username,
        text: text ?? '',
        dateTime: e.eventDateTime,
        timezoneOffsetMin: mapped.timezoneOffsetMin,
        locationDescription: mapped.locationDescription,
      });
    }
  }

  const currentVehicle =
    [...input.events].sort(byTimeDesc).map((e) => (e.vehicleId ? vehicleById.get(e.vehicleId) : undefined)).find(Boolean) ??
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
      trailerNumbers: formatTrailerField(input.currentTripDetails?.trailerNumbers ?? []),
    },
    current: currentPosition(input.events, positioningMalfunctionAt(input.generatedAt)),
    shippingDocumentNumber: input.shippingDocumentNumber || formatShippingDocumentField(input.currentTripDetails?.shippingDocuments ?? []),
    carrier: { usdotNumber: carrier.dotNumber, name: carrier.name },
    eldIdentifier: input.eldIdentifier,
    eldRegistrationId: input.eldRegistrationId,
    eldAuthenticationValue: input.eldAuthenticationValue,
    outputFileComment: input.outputFileComment,
    generatedAt: input.generatedAt,
    users,
    cmvs,
    events,
    annotations,
    certifications,
    malfunctions,
    loginLogout,
    enginePower,
    unidentified: input.unidentifiedEvents.map((e) => ({ ...toOutputEvent(e), userOrderNumber: null })),
  };
}

const UNIDENTIFIED_KEY = '__unidentified__';

function powerRowTripFields(details: TripDetails | undefined): Pick<OutputFileEvent, 'trailerNumbers' | 'shippingDocumentNumber'> {
  if (!details) return {};
  return {
    trailerNumbers: formatTrailerField(details.trailerNumbers),
    shippingDocumentNumber: formatShippingDocumentField(details.shippingDocuments),
  };
}

/** `value - base` rounded to `digits` decimals; null when either side is unknown or it goes negative. */
function difference(value: number | null, base: number | null, digits: number): number | null {
  if (value === null || base === null) return null;
  const f = 10 ** digits;
  const d = Math.round((value - base) * f) / f;
  return d >= 0 ? d : null;
}

/**
 * Appendix A 4.3.1.3 / 4.3.1.4 — accumulated vehicle miles and elapsed engine hours are
 * measured from the engine's LAST POWER-UP on the same CMV. Returns that power-up's totals
 * for a record, from active power-up records (type 6, code 1/2) inside the exported range.
 * A record with no visible power-up before it gets null (rendered blank) — never a guess.
 */
export function powerUpBaseline(records: EldEvent[]): (e: EldEvent) => { miles: number | null; hours: number | null } | null {
  const powerUps = records
    .filter((r) => r.eventType === EVENT_TYPE.POWER && POWER_UP_CODES.includes(r.eventCode) && r.recordStatus === 1 && r.vehicleId)
    .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime());
  return (e: EldEvent) => {
    if (!e.vehicleId) return null;
    let found: EldEvent | null = null;
    for (const p of powerUps) {
      if (p.eventDateTime.getTime() > e.eventDateTime.getTime()) break;
      if (p.vehicleId === e.vehicleId) found = p;
    }
    return found ? { miles: found.totalVehicleMiles ?? null, hours: toNumber(found.totalEngineHours) } : null;
  };
}

/** Header line 6 (4.8.2.1.1) — position and totals of the driver's latest active record. */
function currentPosition(events: EldEvent[], positioningMalfunction: boolean): OutputFileCurrent | null {
  const active = events.filter((e) => e.recordStatus === 1).sort(byTimeDesc);
  const latest = active[0];
  if (!latest) return null;
  const withMiles = active.find((e) => e.totalVehicleMiles !== null && e.totalVehicleMiles !== undefined);
  const withHours = active.find((e) => toNumber(e.totalEngineHours) !== null);
  return {
    latitude: toNumber(latest.latitude),
    longitude: toNumber(latest.longitude),
    locationPrecisionMi: latest.locationPrecisionMi,
    totalVehicleMiles: withMiles?.totalVehicleMiles ?? null,
    totalEngineHours: toNumber(withHours?.totalEngineHours),
    positioningMalfunction,
    locationDescription: manualLocationDescription(latest),
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
 * Whether at least one malfunction (set code 1 / clear code 2) or data diagnostic (set 3 /
 * clear 4) of eventType 7 was active at an instant — Appendix A 7.35 / 7.7. Keyed by the
 * malfunction/diagnostic code (7.34). Only records inside the exported range are visible.
 */
export function indicatorTimeline(events: EldEvent[], setCode: number, clearCode: number): (at: Date) => boolean {
  const changes = events
    .filter((e) => e.eventType === EVENT_TYPE.MALFUNCTION && e.recordStatus === 1)
    .filter((e) => e.eventCode === setCode || e.eventCode === clearCode)
    .map((e) => ({ at: e.eventDateTime.getTime(), code: e.malfunctionCode ?? e.diagnosticCode ?? '', on: e.eventCode === setCode }))
    .sort((a, b) => a.at - b.at);
  return (at: Date): boolean => {
    const active = new Map<string, boolean>();
    for (const c of changes) {
      if (c.at > at.getTime()) break;
      active.set(c.code, c.on);
    }
    return [...active.values()].some(Boolean);
  };
}

/**
 * Appendix A 4.6.1.4(e) — whether a positioning compliance malfunction (`L`, eventType 7
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

/**
 * Appendix A 4.5.1.4(b)(5) — the "Date of the certified record". `LogsService.certify` stores
 * it verbatim as `comment: certifiedDate=YYYY-MM-DD` (a driver usually certifies YESTERDAY's
 * log, so the event date is the wrong answer). Falls back to the event's home-terminal day.
 */
export function certifiedDateOf(e: EldEvent, offsetMin: number): Date {
  const m = /certifiedDate=(\d{4})-(\d{2})-(\d{2})/.exec(e.comment ?? '');
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
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
