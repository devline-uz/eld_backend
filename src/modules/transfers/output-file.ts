/**
 * eRODS output file GENERATOR — 49 CFR §395 Appendix A section 7 (tz.md §10.2).
 *
 * Pure: takes an already-assembled snapshot of RODS data and returns the CSV text plus the
 * check values. No Prisma, no Nest, no clock, no I/O — so it is fully unit-testable and the
 * validator can round-trip its output.
 *
 * TEST mode changes NOTHING about this file: tz.md §10.1 requires the output file to be
 * generated "fully and correctly" in TEST mode; only the SEND step is suppressed.
 */
import { fileDataCheckValue, renderDataLine, splitDataLine } from './check-value';
import {
  ANNOTATION_MAX,
  ELD_IDENTIFIER_LENGTH,
  LIST_COLUMNS,
  OUTPUT_FILE_COMMENT_MAX,
  SEGMENT_TITLES,
} from './segments';

/** Appendix A line terminator: CRLF, so the file opens unchanged on an inspector's laptop. */
export const LINE_TERMINATOR = '\r\n';

export interface OutputFileDriver {
  lastName: string;
  firstName: string;
  username: string;
  licenseState: string;
  licenseNumber: string;
  /** 7 or 8 — §395 multiday basis (60/7 vs 70/8). */
  multidayBasis: 7 | 8;
  exempt: boolean;
  /** Signed minutes to ADD to UTC to reach home-terminal time (EDT = -240). */
  timezoneOffsetMin: number;
}

export interface OutputFileCoDriver {
  lastName: string;
  firstName: string;
  username: string;
}

export interface OutputFileUser {
  orderNumber: number;
  username: string;
  lastName: string;
  firstName: string;
  /** `D` driver · `S` support personnel (Appendix A ELD Account Type). */
  accountType: 'D' | 'S';
}

export interface OutputFileCmv {
  orderNumber: number;
  powerUnitNumber: string;
  vin: string;
}

export interface OutputFileEvent {
  /** §7.3 — allocated once at ingest, 1..65535, rendered as 4 hex digits. */
  sequenceId: number;
  recordStatus: number;
  recordOrigin: number;
  eventType: number;
  eventCode: number;
  dateTime: Date;
  /** Signed minutes to add to UTC for the home terminal (per event, for DST correctness). */
  timezoneOffsetMin: number;
  totalVehicleMiles: number | null;
  totalEngineHours: number | null;
  latitude: number | null;
  longitude: number | null;
  /** 1 mile normally, 10 for personal conveyance — drives lat/long resolution. */
  locationPrecisionMi: number;
  distanceSinceLastValidCoords: number | null;
  cmvOrderNumber: number | null;
  userOrderNumber: number | null;
  malfunctionIndicator: boolean;
  diagnosticIndicator: boolean;
  malfunctionCode?: string | null;
  diagnosticCode?: string | null;
}

export interface OutputFileAnnotation {
  sequenceId: number;
  userOrderNumber: number | null;
  text: string;
  dateTime: Date;
  timezoneOffsetMin: number;
}

export interface OutputFileCertification {
  sequenceId: number;
  /** 1 for the first certification of a day, then 2..9 saturating (§9.4). */
  eventCode: number;
  dateTime: Date;
  timezoneOffsetMin: number;
  /** The RODS day being certified. */
  certifiedDate: Date;
}

export interface OutputFileInput {
  driver: OutputFileDriver;
  coDriver?: OutputFileCoDriver | null;
  /** Power unit / VIN / trailer that head the header segment (current or last known). */
  currentCmv: { powerUnitNumber: string; vin: string; trailerNumbers: string };
  shippingDocumentNumber: string;
  carrier: { usdotNumber: string; name: string };
  /** Appendix A: EXACTLY 4 characters. `OBK1` until FMCSA registration (tz.md §10.1). */
  eldIdentifier: string;
  eldRegistrationId: string;
  eldAuthenticationValue: string;
  outputFileComment: string;
  /** Generation instant — the header's "Current Date"/"Current Time". */
  generatedAt: Date;
  users: OutputFileUser[];
  cmvs: OutputFileCmv[];
  /** eventType 7 records. */
  malfunctions: OutputFileEvent[];
  /** eventType 1/2/3/5/6 records for this driver, active AND superseded. */
  events: OutputFileEvent[];
  annotations: OutputFileAnnotation[];
  certifications: OutputFileCertification[];
  /** Driving records with no identified driver (recordOrigin 4). */
  unidentified: OutputFileEvent[];
}

export interface GeneratedOutputFile {
  /** Full CSV text, CRLF-terminated lines. */
  csv: string;
  /** Appendix A 4.4.5.4 file data check value (2 hex digits). */
  fileCheckValue: string;
  lineCount: number;
}

// --- field formatters -------------------------------------------------------

/**
 * Appendix A payload is printable ASCII with `,` reserved as the delimiter. Commas, CR, LF
 * and non-printable characters are REMOVED (never escaped: Appendix A has no quoting rule).
 */
export function csvField(value: string | null | undefined, maxLength?: number): string {
  const cleaned = (value ?? '')
    .replace(/[\r\n,]/g, ' ')
     
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** Home-terminal local time for an event stored in UTC. */
function toLocal(dateTime: Date, offsetMin: number): Date {
  return new Date(dateTime.getTime() + offsetMin * 60_000);
}

/** Appendix A date field: MMDDYY. */
export function formatEventDate(dateTime: Date, offsetMin: number): string {
  const d = toLocal(dateTime, offsetMin);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${mm}${dd}${yy}`;
}

/** Appendix A time field: HHMMSS, 24-hour, home-terminal time. */
export function formatEventTime(dateTime: Date, offsetMin: number): string {
  const d = toLocal(dateTime, offsetMin);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join('');
}

/** Header "Time Zone Offset from UTC": whole hours to SUBTRACT from UTC (EST = 5). */
export function formatTimeZoneOffset(offsetMin: number): string {
  return String(Math.round(Math.abs(offsetMin) / 60));
}

/** §7.3 — Event Sequence ID as 4 hex digits, `0001`..`FFFF`. */
export function formatSequenceId(sequenceId: number): string {
  const wrapped = ((Math.trunc(sequenceId) - 1) % 65535 + 65535) % 65535 + 1;
  return wrapped.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Appendix A position resolution: 0.01 degree normally, 0.1 degree when the record was taken
 * at reduced precision (personal conveyance — 10-mile accuracy, tz.md §7 / §23).
 */
export function formatCoordinate(value: number | null, precisionMi: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return value.toFixed(precisionMi >= 10 ? 1 : 2);
}

/** Integer miles; empty when unknown (Appendix A allows an empty field, never a fake 0). */
export function formatMiles(value: number | null): string {
  return value === null || value === undefined ? '' : String(Math.trunc(value));
}

/** Engine hours at 0.1 h resolution. */
export function formatEngineHours(value: number | null): string {
  return value === null || value === undefined ? '' : value.toFixed(1);
}

function formatOrder(value: number | null): string {
  return value === null || value === undefined ? '' : String(value);
}

// --- segment renderers ------------------------------------------------------

function headerLines(input: OutputFileInput): string[][] {
  const { driver, coDriver, currentCmv, carrier } = input;
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
    [csvField(carrier.usdotNumber), csvField(carrier.name), String(driver.multidayBasis)],
    [csvField(input.shippingDocumentNumber)],
    [driver.exempt ? 'E' : 'N'],
    [
      formatTimeZoneOffset(driver.timezoneOffsetMin),
      formatEventDate(input.generatedAt, driver.timezoneOffsetMin),
      formatEventTime(input.generatedAt, driver.timezoneOffsetMin),
    ],
    [csvField(input.eldRegistrationId), csvField(input.eldIdentifier), csvField(input.eldAuthenticationValue)],
    [csvField(input.outputFileComment, OUTPUT_FILE_COMMENT_MAX)],
  ];
}

function eventFields(e: OutputFileEvent): string[] {
  return [
    formatSequenceId(e.sequenceId),
    String(e.recordStatus),
    String(e.recordOrigin),
    String(e.eventType),
    String(e.eventCode),
    formatEventDate(e.dateTime, e.timezoneOffsetMin),
    formatEventTime(e.dateTime, e.timezoneOffsetMin),
    formatMiles(e.totalVehicleMiles),
    formatEngineHours(e.totalEngineHours),
    formatCoordinate(e.latitude, e.locationPrecisionMi),
    formatCoordinate(e.longitude, e.locationPrecisionMi),
    formatMiles(e.distanceSinceLastValidCoords),
    formatOrder(e.cmvOrderNumber),
    formatOrder(e.userOrderNumber),
    e.malfunctionIndicator ? '1' : '0',
    e.diagnosticIndicator ? '1' : '0',
  ];
}

/** Unidentified driving records carry no user order number and no indicator statuses. */
function unidentifiedFields(e: OutputFileEvent): string[] {
  return eventFields(e).slice(0, LIST_COLUMNS.unidentified.length);
}

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

/**
 * Appendix A: the ELD Identifier is EXACTLY 4 characters. A 6-character value (the old
 * `TEST01`) invalidates the whole file, so the generator REFUSES to write one rather than
 * silently truncating it into a different, wrong identifier. The DB `CHECK` on
 * `Carrier.eldIdentifier` makes this unreachable from the carrier profile; this guard covers
 * every other caller (tests, scripts, a future import path).
 */
function assertEldIdentifiers(input: OutputFileInput): void {
  const identifier = csvField(input.eldIdentifier);
  if (identifier.length !== ELD_IDENTIFIER_LENGTH || !/^[A-Z0-9]{4}$/.test(identifier)) {
    throw new RangeError(
      `ELD Identifier must be exactly ${ELD_IDENTIFIER_LENGTH} characters of [A-Z0-9] (Appendix A), got "${identifier}".`,
    );
  }
  const registrationId = csvField(input.eldRegistrationId);
  if (registrationId !== '' && (registrationId.length !== ELD_IDENTIFIER_LENGTH || !/^[A-Z0-9]{4}$/.test(registrationId))) {
    throw new RangeError(
      `ELD Registration ID must be exactly ${ELD_IDENTIFIER_LENGTH} characters of [A-Z0-9], got "${registrationId}".`,
    );
  }
}

/** Builds the Appendix A output file. The only writer of eRODS CSV in the system. */
export function buildOutputFile(input: OutputFileInput): GeneratedOutputFile {
  assertEldIdentifiers(input);
  const lines: string[] = [];
  const checkValues: string[] = [];

  const push = (fields: readonly string[]): void => {
    const line = renderDataLine(fields);
    lines.push(line);
    checkValues.push(splitDataLine(line).checkValue);
  };

  // 1 — Header (fixed 9 lines).
  lines.push(SEGMENT_TITLES.header);
  for (const fields of headerLines(input)) push(fields);

  // 2 — User list.
  lines.push(SEGMENT_TITLES.users);
  for (const u of input.users) {
    push([
      String(u.orderNumber),
      csvField(u.username),
      csvField(u.lastName),
      csvField(u.firstName),
      u.accountType,
    ]);
  }

  // 3 — CMV list.
  lines.push(SEGMENT_TITLES.cmvs);
  for (const c of input.cmvs) push([String(c.orderNumber), csvField(c.powerUnitNumber), csvField(c.vin)]);

  // 4 — Malfunction / diagnostic list.
  lines.push(SEGMENT_TITLES.malfunctions);
  for (const m of input.malfunctions) push(malfunctionFields(m));

  // 5 — Event list.
  lines.push(SEGMENT_TITLES.events);
  for (const e of input.events) push(eventFields(e));

  // 6 — Annotation / comment list.
  lines.push(SEGMENT_TITLES.annotations);
  for (const a of input.annotations) {
    push([
      formatSequenceId(a.sequenceId),
      formatOrder(a.userOrderNumber),
      csvField(a.text, ANNOTATION_MAX),
      formatEventDate(a.dateTime, a.timezoneOffsetMin),
      formatEventTime(a.dateTime, a.timezoneOffsetMin),
    ]);
  }

  // 7 — Certification list.
  lines.push(SEGMENT_TITLES.certifications);
  for (const c of input.certifications) {
    push([
      formatSequenceId(c.sequenceId),
      String(c.eventCode),
      formatEventDate(c.dateTime, c.timezoneOffsetMin),
      formatEventTime(c.dateTime, c.timezoneOffsetMin),
      formatEventDate(c.certifiedDate, 0),
    ]);
  }

  // 8 — Unidentified driving list.
  lines.push(SEGMENT_TITLES.unidentified);
  for (const e of input.unidentified) push(unidentifiedFields(e));

  // 9 — File data check value (Appendix A 4.4.5.4) — not itself a checked data line.
  const fileCheckValue = fileDataCheckValue(checkValues);
  lines.push(SEGMENT_TITLES.endOfFile);
  lines.push(fileCheckValue);

  return {
    csv: lines.join(LINE_TERMINATOR) + LINE_TERMINATOR,
    fileCheckValue,
    lineCount: lines.length,
  };
}
