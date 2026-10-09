/**
 * eRODS output file GENERATOR — 49 CFR §395 Subpart B Appendix A 4.8.2.1 (tz.md §10.2).
 *
 * Pure: takes an already-assembled snapshot of RODS data and returns the CSV text plus the
 * check values. No Prisma, no Nest, no clock, no I/O — so it is fully unit-testable and the
 * validator can round-trip its output. Layout lives in `segments.ts` (diffed against the
 * official text in `docs/fmcsa/`, D-024).
 *
 * TEST mode changes NOTHING about this file: tz.md §10.1 requires the output file to be
 * generated "fully and correctly" in TEST mode; only the SEND step is suppressed.
 */
import { eventDataCheckValue, fileDataCheckValue, renderDataLine, splitDataLine } from './check-value';
import {
  ANNOTATION_MAX,
  DEFAULT_PERIOD_START_TIME,
  DISTANCE_SINCE_LAST_VALID_MAX,
  ELD_IDENTIFIER_LENGTH,
  ELD_REGISTRATION_ID_LENGTH,
  ENGINE_POWER_EVENT_TYPE,
  EVENT_LIST_TYPES,
  LOCATION_DESCRIPTION_MAX,
  LOGIN_LOGOUT_EVENT_TYPE,
  OUTPUT_FILE_COMMENT_MAX,
  SEGMENT_TITLES,
  UNIDENTIFIED_PROFILE,
} from './segments';

/** Line terminator (<CR>, Appendix A 3.2(c)): CRLF, so the file opens unchanged on an inspector's laptop. */
export const LINE_TERMINATOR = '\r\n';

export interface OutputFileDriver {
  lastName: string;
  firstName: string;
  username: string;
  licenseState: string;
  licenseNumber: string;
  /** 7 or 8 — Appendix A 7.36 multiday basis (60/7 vs 70/8). */
  multidayBasis: 7 | 8;
  exempt: boolean;
  /** Signed minutes to ADD to UTC to reach home-terminal time (EDT = -240). */
  timezoneOffsetMin: number;
  /** Appendix A 7.1 — 24-hour period starting time, HHMMSS home-terminal time. Default `000000`. */
  periodStartTime?: string;
}

export interface OutputFileCoDriver {
  lastName: string;
  firstName: string;
  username: string;
}

export interface OutputFileUser {
  orderNumber: number;
  /** Kept for the snapshot's own bookkeeping; the 4.8.2.1.2 user list has NO username column. */
  username: string;
  lastName: string;
  firstName: string;
  /** Appendix A 7.13: `D` driver (and the unidentified profile) · `S` support personnel. */
  accountType: 'D' | 'S';
}

export interface OutputFileCmv {
  orderNumber: number;
  powerUnitNumber: string;
  vin: string;
}

export interface OutputFileEvent {
  /** Appendix A 7.24 — 0..FFFF, rendered as hex. */
  sequenceId: number;
  recordStatus: number;
  recordOrigin: number;
  eventType: number;
  eventCode: number;
  dateTime: Date;
  /** Signed minutes to add to UTC for the home terminal (per event, for DST correctness). */
  timezoneOffsetMin: number;
  /** Total (odometer) miles — malfunction, login/logout and engine power rows (7.43). */
  totalVehicleMiles: number | null;
  /** Total engine hours — malfunction, login/logout and engine power rows (7.19). */
  totalEngineHours: number | null;
  /**
   * Appendix A 4.3.1.3 / 7.43 — miles since the engine's last power-up. Used by the event and
   * unidentified lists (4.8.2.1.4 / 4.8.2.1.10). Empty when it cannot be determined.
   */
  accumulatedVehicleMiles?: number | null;
  /** Appendix A 4.3.1.4 / 7.19 — engine hours since the last power-up (event/unidentified lists). */
  elapsedEngineHours?: number | null;
  latitude: number | null;
  longitude: number | null;
  /** 1 mile normally, 10 for personal conveyance — drives lat/long resolution (4.7.3(b)(1)). */
  locationPrecisionMi: number;
  distanceSinceLastValidCoords: number | null;
  cmvOrderNumber: number | null;
  userOrderNumber: number | null;
  /** Appendix A 7.35 — at least one malfunction active when the record was made. */
  malfunctionIndicator: boolean;
  /** Appendix A 7.7 — at least one data diagnostic event active for the driver. */
  diagnosticIndicator: boolean;
  malfunctionCode?: string | null;
  diagnosticCode?: string | null;
  /**
   * Appendix A 4.3.2.7 / 7.12 — the Driver's Location Description, set ONLY when the driver
   * entered the location by hand because there was no valid position. Drives the `M` marker
   * (4.3.2.7(c), 4.6.1.4(d)). Geocoded names stay null.
   */
  locationDescription?: string | null;
  /** Appendix A 4.6.1.4(e) — a positioning compliance malfunction (`L`) was active. */
  positioningMalfunction?: boolean;
  /**
   * ELD username that feeds the Event Data Check Value (4.4.5.1.1(b)(10)) and the login/logout
   * row (4.8.2.1.8). Defaults to the inspected driver (event list) or the unidentified profile.
   */
  username?: string | null;
  /** A stored Event Data Check Value (2 hex) — used verbatim instead of recomputing (4.4.5(c)). */
  eventDataCheckValue?: string | null;
  /** Engine power-up / shut-down rows only (4.8.2.1.9). */
  trailerNumbers?: string | null;
  shippingDocumentNumber?: string | null;
}

export interface OutputFileAnnotation {
  sequenceId: number;
  /** Appendix A 4.8.2.1.5 — ELD username of the record originator. */
  username: string;
  text: string;
  dateTime: Date;
  timezoneOffsetMin: number;
  /** Appendix A 7.12 Driver's Location Description (manual entries only, 5-60 chars). */
  locationDescription?: string | null;
}

export interface OutputFileCertification {
  sequenceId: number;
  /** 1 for the first certification of a day, then 2..9 saturating (§9.4). */
  eventCode: number;
  dateTime: Date;
  timezoneOffsetMin: number;
  /** The RODS day being certified (UTC midnight of that calendar date). */
  certifiedDate: Date;
  /** Appendix A 4.8.2.1.6 — Corresponding CMV Order Number. */
  cmvOrderNumber?: number | null;
}

/** Appendix A 4.8.2.1.1 header line 6 — the CMV's current position and totals. */
export interface OutputFileCurrent {
  latitude: number | null;
  longitude: number | null;
  locationPrecisionMi: number;
  totalVehicleMiles: number | null;
  totalEngineHours: number | null;
  positioningMalfunction?: boolean;
  locationDescription?: string | null;
}

export interface OutputFileInput {
  driver: OutputFileDriver;
  coDriver?: OutputFileCoDriver | null;
  /** Power unit / VIN / trailer that head the header segment (current or last known). */
  currentCmv: { powerUnitNumber: string; vin: string; trailerNumbers: string };
  /** Header line 6 — current position / totals. Absent -> `X`,`X` and empty totals. */
  current?: OutputFileCurrent | null;
  shippingDocumentNumber: string;
  carrier: { usdotNumber: string; name: string };
  /** Appendix A 7.15 — 6 chars [A-Z0-9]; registration ID 7.17 — 4 chars (`segments.ts`). */
  eldIdentifier: string;
  eldRegistrationId: string;
  eldAuthenticationValue: string;
  outputFileComment: string;
  /** Generation instant — the header's "Current Date"/"Current Time". */
  generatedAt: Date;
  /** Rank-ordered, most recent user on top (4.8.2.1.2). */
  users: OutputFileUser[];
  /** Rank-ordered, most recent CMV on top (4.8.2.1.3). */
  cmvs: OutputFileCmv[];
  /** eventType 1/2/3 records for this driver, active AND superseded (4.8.2.1.4). */
  events: OutputFileEvent[];
  annotations: OutputFileAnnotation[];
  certifications: OutputFileCertification[];
  /** eventType 7 records (4.8.2.1.7). */
  malfunctions: OutputFileEvent[];
  /** eventType 5 records (4.8.2.1.8). */
  loginLogout?: OutputFileEvent[];
  /** eventType 6 records (4.8.2.1.9). */
  enginePower?: OutputFileEvent[];
  /** Records of the unidentified driver profile (recordOrigin 4) (4.8.2.1.10). */
  unidentified: OutputFileEvent[];
}

export interface GeneratedOutputFile {
  /** Full CSV text, CRLF-terminated lines. */
  csv: string;
  /** Appendix A 4.4.5.3 file data check value (4 hex digits). */
  fileCheckValue: string;
  lineCount: number;
}

// --- field formatters -------------------------------------------------------

/**
 * Appendix A 4.8.2.1(b): printable ASCII only. 4.8.2.1(b)(3): a comma or a carriage return
 * (<CR>, i.e. CRLF / CR / LF — 3.2(c)) inside a value is REPLACED WITH A SEMICOLON. Other
 * control and non-ASCII characters are dropped; runs of spaces collapse; ends are trimmed.
 */
export function csvField(value: string | null | undefined, maxLength?: number): string {
  const cleaned = (value ?? '')
    .replace(/\r\n|[\r\n,]/g, ';')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/ +/g, ' ')
    .trim();
  return maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** Home-terminal local time for an event stored in UTC. */
function toLocal(dateTime: Date, offsetMin: number): Date {
  return new Date(dateTime.getTime() + offsetMin * 60_000);
}

/** Appendix A 7.8 date field: MMDDYY. */
export function formatEventDate(dateTime: Date, offsetMin: number): string {
  const d = toLocal(dateTime, offsetMin);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${mm}${dd}${yy}`;
}

/** Appendix A 7.40 time field: HHMMSS, 24-hour, home-terminal time. */
export function formatEventTime(dateTime: Date, offsetMin: number): string {
  const d = toLocal(dateTime, offsetMin);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join('');
}

/** Appendix A 7.41: 2 digits, hours of difference from UTC, sign omitted (EDT -> `04`). */
export function formatTimeZoneOffset(offsetMin: number): string {
  return String(Math.round(Math.abs(offsetMin) / 60)).padStart(2, '0');
}

/** Appendix A 7.24 — Event Sequence ID, 0..FFFF (after FFFF comes 0), as 4 hex digits. */
export function formatSequenceId(sequenceId: number): string {
  const wrapped = ((Math.trunc(sequenceId) % 65536) + 65536) % 65536;
  return wrapped.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Appendix A 7.31 / 7.33 resolution: 0.01 degree normally, 0.1 degree at reduced precision
 * (personal conveyance, 4.7.3(b)(1)).
 */
export function formatCoordinate(value: number | null, precisionMi: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const text = value.toFixed(precisionMi >= 10 ? 1 : 2);
  // A value that rounds to zero is written without a sign (7.31 / 7.33: the minus sign marks
  // south / west), so -0.001 -> `0.00`, never `-0.00`.
  return /^-0\.0+$/.test(text) ? text.slice(1) : text;
}

interface Positioned {
  latitude: number | null;
  longitude: number | null;
  locationPrecisionMi: number;
  locationDescription?: string | null;
  positioningMalfunction?: boolean;
}

/**
 * Appendix A 7.31 / 7.33 / 4.6.1.4 — the latitude / longitude pair of a record that carries one.
 *
 *   positioning compliance malfunction set  -> `E`,`E` (4.6.1.4(e), even if a location was typed)
 *   valid position                          -> decimal degrees (0.01 deg; 0.1 deg reduced precision)
 *   no position, driver typed the location  -> `M`,`M` (4.3.2.7(c), 4.6.1.4(d))
 *   no position, nothing typed              -> `X`,`X` (4.6.1.4(d))
 */
export function formatEventPosition(e: Positioned): [string, string] {
  if (e.positioningMalfunction) return ['E', 'E'];
  const valid = (v: number | null): v is number => v !== null && v !== undefined && Number.isFinite(v);
  if (valid(e.latitude) && valid(e.longitude)) {
    return [formatCoordinate(e.latitude, e.locationPrecisionMi), formatCoordinate(e.longitude, e.locationPrecisionMi)];
  }
  if (csvField(e.locationDescription) !== '') return ['M', 'M'];
  return ['X', 'X'];
}

/** Integer miles; empty when unknown (7.43 allows blank, never a fake 0). */
export function formatMiles(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(Math.trunc(value));
}

/** Engine hours at 0.1 h resolution (7.19); empty when unknown. */
export function formatEngineHours(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : value.toFixed(1);
}

/** Appendix A 7.9 — integer 0..6, anything above 6 is written as 6; mandatory, unknown -> 0. */
export function formatDistanceSinceLastValid(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '0';
  return String(Math.min(DISTANCE_SINCE_LAST_VALID_MAX, Math.max(0, Math.trunc(value))));
}

function formatOrder(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Most current record on top (4.8.2.1.4-10); ties broken by the higher sequence id. */
function mostRecentFirst<T extends { dateTime: Date; sequenceId: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime() || b.sequenceId - a.sequenceId);
}

// --- segment renderers ------------------------------------------------------

function headerLines(input: OutputFileInput): string[][] {
  const { driver, coDriver, currentCmv, carrier } = input;
  const current = input.current ?? null;
  const [curLat, curLon] = current ? formatEventPosition(current) : ['X', 'X'];
  return [
    [
      csvField(driver.lastName),
      csvField(driver.firstName),
      csvField(driver.username),
      csvField(driver.licenseState),
      csvField(driver.licenseNumber),
    ],
    [csvField(coDriver?.lastName), csvField(coDriver?.firstName), csvField(coDriver?.username)],
    [csvField(currentCmv.powerUnitNumber), csvField(currentCmv.vin), csvField(currentCmv.trailerNumbers)],
    [
      csvField(carrier.usdotNumber),
      csvField(carrier.name),
      String(driver.multidayBasis),
      csvField(driver.periodStartTime) || DEFAULT_PERIOD_START_TIME,
      formatTimeZoneOffset(driver.timezoneOffsetMin),
    ],
    // 7.26: `E` exempt or `0` (number zero).
    [csvField(input.shippingDocumentNumber), driver.exempt ? 'E' : '0'],
    [
      formatEventDate(input.generatedAt, driver.timezoneOffsetMin),
      formatEventTime(input.generatedAt, driver.timezoneOffsetMin),
      curLat,
      curLon,
      formatMiles(current?.totalVehicleMiles),
      formatEngineHours(current?.totalEngineHours),
    ],
    [
      csvField(input.eldRegistrationId),
      csvField(input.eldIdentifier),
      csvField(input.eldAuthenticationValue),
      csvField(input.outputFileComment, OUTPUT_FILE_COMMENT_MAX),
    ],
  ];
}

/** CMV power unit number for a record, from the CMV list (4.4.5.1.1(b)(9)). */
function powerUnitOf(input: OutputFileInput, cmvOrderNumber: number | null): string {
  if (cmvOrderNumber === null || cmvOrderNumber === undefined) return '';
  return csvField(input.cmvs.find((c) => c.orderNumber === cmvOrderNumber)?.powerUnitNumber);
}

/**
 * Appendix A 4.4.5.1 — the Event Data Check Value of an event-list / unidentified row, over the
 * values as they appear in that row (accumulated miles / elapsed hours, position markers).
 */
function eventCheckOf(input: OutputFileInput, e: OutputFileEvent, defaultUsername: string, latLon: [string, string]): string {
  if (e.eventDataCheckValue && /^[0-9A-F]{2}$/.test(e.eventDataCheckValue)) return e.eventDataCheckValue;
  return eventDataCheckValue([
    String(e.eventType),
    String(e.eventCode),
    formatEventDate(e.dateTime, e.timezoneOffsetMin),
    formatEventTime(e.dateTime, e.timezoneOffsetMin),
    formatMiles(e.accumulatedVehicleMiles),
    formatEngineHours(e.elapsedEngineHours),
    latLon[0],
    latLon[1],
    powerUnitOf(input, e.cmvOrderNumber),
    csvField(e.username) || defaultUsername,
  ]);
}

/** 4.8.2.1.4 — ELD Event List row. */
function eventFields(input: OutputFileInput, e: OutputFileEvent): string[] {
  const position = formatEventPosition(e);
  return [
    formatSequenceId(e.sequenceId),
    String(e.recordStatus),
    String(e.recordOrigin),
    String(e.eventType),
    String(e.eventCode),
    formatEventDate(e.dateTime, e.timezoneOffsetMin),
    formatEventTime(e.dateTime, e.timezoneOffsetMin),
    formatMiles(e.accumulatedVehicleMiles),
    formatEngineHours(e.elapsedEngineHours),
    position[0],
    position[1],
    formatDistanceSinceLastValid(e.distanceSinceLastValidCoords),
    formatOrder(e.cmvOrderNumber),
    formatOrder(e.userOrderNumber),
    e.malfunctionIndicator ? '1' : '0',
    e.diagnosticIndicator ? '1' : '0',
    eventCheckOf(input, e, csvField(input.driver.username), position),
  ];
}

/** 4.8.2.1.10 — Unidentified Driver Profile row: no user order number, no diagnostic indicator. */
function unidentifiedFields(input: OutputFileInput, e: OutputFileEvent): string[] {
  const position = formatEventPosition(e);
  return [
    formatSequenceId(e.sequenceId),
    String(e.recordStatus),
    String(e.recordOrigin),
    String(e.eventType),
    String(e.eventCode),
    formatEventDate(e.dateTime, e.timezoneOffsetMin),
    formatEventTime(e.dateTime, e.timezoneOffsetMin),
    formatMiles(e.accumulatedVehicleMiles),
    formatEngineHours(e.elapsedEngineHours),
    position[0],
    position[1],
    formatDistanceSinceLastValid(e.distanceSinceLastValidCoords),
    formatOrder(e.cmvOrderNumber),
    e.malfunctionIndicator ? '1' : '0',
    eventCheckOf(input, e, UNIDENTIFIED_PROFILE.username, position),
  ];
}

/** 4.8.2.1.7 — Malfunction / data diagnostic row. */
function malfunctionFields(e: OutputFileEvent): string[] {
  return [
    formatSequenceId(e.sequenceId),
    String(e.eventCode),
    csvField(e.malfunctionCode ?? e.diagnosticCode ?? ''),
    formatEventDate(e.dateTime, e.timezoneOffsetMin),
    formatEventTime(e.dateTime, e.timezoneOffsetMin),
    formatMiles(e.totalVehicleMiles),
    formatEngineHours(e.totalEngineHours),
    formatOrder(e.cmvOrderNumber),
  ];
}

/** 4.8.2.1.8 — Login/logout row. */
function loginLogoutFields(input: OutputFileInput, e: OutputFileEvent): string[] {
  return [
    formatSequenceId(e.sequenceId),
    String(e.eventCode),
    csvField(e.username) || csvField(input.driver.username),
    formatEventDate(e.dateTime, e.timezoneOffsetMin),
    formatEventTime(e.dateTime, e.timezoneOffsetMin),
    formatMiles(e.totalVehicleMiles),
    formatEngineHours(e.totalEngineHours),
  ];
}

/** 4.8.2.1.9 — CMV engine power-up / shut-down row. */
function enginePowerFields(input: OutputFileInput, e: OutputFileEvent): string[] {
  const [latitude, longitude] = formatEventPosition(e);
  const cmv = input.cmvs.find((c) => c.orderNumber === e.cmvOrderNumber);
  return [
    formatSequenceId(e.sequenceId),
    String(e.eventCode),
    formatEventDate(e.dateTime, e.timezoneOffsetMin),
    formatEventTime(e.dateTime, e.timezoneOffsetMin),
    formatMiles(e.totalVehicleMiles),
    formatEngineHours(e.totalEngineHours),
    latitude,
    longitude,
    csvField(cmv?.powerUnitNumber),
    csvField(cmv?.vin),
    csvField(e.trailerNumbers),
    csvField(e.shippingDocumentNumber),
  ];
}

/**
 * Registration ID (7.17) is exactly 4 chars of [A-Z0-9] when present (empty is tolerated in
 * TEST mode before FMCSA registration). The ELD Identifier is exactly 6 chars (7.15, B-138). The generator
 * REFUSES a malformed value rather than silently truncating it into a different identifier.
 */
function assertEldIdentifiers(input: OutputFileInput): void {
  const identifier = csvField(input.eldIdentifier);
  if (identifier.length !== ELD_IDENTIFIER_LENGTH || !/^[A-Z0-9]+$/.test(identifier)) {
    throw new RangeError(
      `ELD Identifier must be exactly ${ELD_IDENTIFIER_LENGTH} characters of [A-Z0-9] (7.15), got "${identifier}".`,
    );
  }
  const registrationId = csvField(input.eldRegistrationId);
  if (registrationId !== '' && (registrationId.length !== ELD_REGISTRATION_ID_LENGTH || !/^[A-Z0-9]+$/.test(registrationId))) {
    throw new RangeError(
      `ELD Registration ID must be exactly ${ELD_REGISTRATION_ID_LENGTH} characters of [A-Z0-9] (7.17), got "${registrationId}".`,
    );
  }
}

/** The event list holds event types 1, 2, 3 only (4.8.2.1.4); 5 and 6 have their own segments. */
function assertEventListTypes(input: OutputFileInput): void {
  const stray = input.events.find((e) => !EVENT_LIST_TYPES.includes(e.eventType));
  if (stray) {
    const hint =
      stray.eventType === LOGIN_LOGOUT_EVENT_TYPE
        ? ' (use `loginLogout`)'
        : stray.eventType === ENGINE_POWER_EVENT_TYPE
          ? ' (use `enginePower`)'
          : '';
    throw new RangeError(`ELD Event List accepts event types 1, 2, 3 only (4.8.2.1.4), got ${stray.eventType}${hint}.`);
  }
}

/** Builds the Appendix A output file. The only writer of eRODS CSV in the system. */
export function buildOutputFile(input: OutputFileInput): GeneratedOutputFile {
  assertEldIdentifiers(input);
  assertEventListTypes(input);
  const lines: string[] = [];
  const checkValues: string[] = [];

  const push = (fields: readonly string[]): void => {
    const line = renderDataLine(fields);
    lines.push(line);
    checkValues.push(splitDataLine(line).checkValue);
  };

  // 4.8.2.1.1 — Header (fixed 7 lines).
  lines.push(SEGMENT_TITLES.header);
  for (const fields of headerLines(input)) push(fields);

  // 4.8.2.1.2 — User list (rank order supplied by the snapshot).
  lines.push(SEGMENT_TITLES.users);
  for (const u of input.users) {
    push([String(u.orderNumber), u.accountType, csvField(u.lastName), csvField(u.firstName)]);
  }

  // 4.8.2.1.3 — CMV list.
  lines.push(SEGMENT_TITLES.cmvs);
  for (const c of input.cmvs) push([String(c.orderNumber), csvField(c.powerUnitNumber), csvField(c.vin)]);

  // 4.8.2.1.4 — ELD event list.
  lines.push(SEGMENT_TITLES.events);
  for (const e of mostRecentFirst(input.events)) push(eventFields(input, e));

  // 4.8.2.1.5 — Annotations, comments and Driver's Location Description.
  lines.push(SEGMENT_TITLES.annotations);
  for (const a of mostRecentFirst(input.annotations)) {
    push([
      formatSequenceId(a.sequenceId),
      csvField(a.username),
      csvField(a.text, ANNOTATION_MAX),
      formatEventDate(a.dateTime, a.timezoneOffsetMin),
      formatEventTime(a.dateTime, a.timezoneOffsetMin),
      csvField(a.locationDescription, LOCATION_DESCRIPTION_MAX),
    ]);
  }

  // 4.8.2.1.6 — Certification list.
  lines.push(SEGMENT_TITLES.certifications);
  for (const c of mostRecentFirst(input.certifications)) {
    push([
      formatSequenceId(c.sequenceId),
      String(c.eventCode),
      formatEventDate(c.dateTime, c.timezoneOffsetMin),
      formatEventTime(c.dateTime, c.timezoneOffsetMin),
      formatEventDate(c.certifiedDate, 0),
      formatOrder(c.cmvOrderNumber),
    ]);
  }

  // 4.8.2.1.7 — Malfunction / diagnostic list.
  lines.push(SEGMENT_TITLES.malfunctions);
  for (const m of mostRecentFirst(input.malfunctions)) push(malfunctionFields(m));

  // 4.8.2.1.8 — Login / logout report.
  lines.push(SEGMENT_TITLES.loginLogout);
  for (const e of mostRecentFirst(input.loginLogout ?? [])) push(loginLogoutFields(input, e));

  // 4.8.2.1.9 — Engine power-up / shut-down activity.
  lines.push(SEGMENT_TITLES.enginePower);
  for (const e of mostRecentFirst(input.enginePower ?? [])) push(enginePowerFields(input, e));

  // 4.8.2.1.10 — Unidentified driver profile records.
  lines.push(SEGMENT_TITLES.unidentified);
  for (const e of mostRecentFirst(input.unidentified)) push(unidentifiedFields(input, e));

  // 4.8.2.1.11 — File data check value (4.4.5.3) — not itself a checked data line.
  const fileCheckValue = fileDataCheckValue(checkValues);
  lines.push(SEGMENT_TITLES.endOfFile);
  lines.push(fileCheckValue);

  return {
    csv: lines.join(LINE_TERMINATOR) + LINE_TERMINATOR,
    fileCheckValue,
    lineCount: lines.length,
  };
}
