/**
 * eRODS output file VALIDATOR — re-parses generated CSV and asserts Appendix A conformance
 * (tz.md §10.2, §23 "Output fayl formati Appendix A ga mos (TEST rejimida ham)").
 *
 * This is deliberately an INDEPENDENT reader: it does not trust the generator's in-memory
 * state, only the bytes. It is run on every generated file before the `DataTransfer` row is
 * marked ready, in TEST mode exactly as in PRODUCTION, so a malformed file can never be
 * handed to an inspector.
 */
import { fileDataCheckValue, splitDataLine, verifyDataLine } from './check-value';
import { LINE_TERMINATOR } from './output-file';
import {
  DISTANCE_SINCE_LAST_VALID_MAX,
  ELD_IDENTIFIER_LENGTH,
  ELD_REGISTRATION_ID_LENGTH,
  HEADER_LINE,
  HEADER_LINES,
  LIST_COLUMNS,
  OUTPUT_FILE_COMMENT_MAX,
  SEGMENT_ORDER,
  SEGMENT_TITLES,
  SegmentKey,
} from './segments';

export interface OutputFileIssue {
  /** Stable machine code so the UI and the audit log can key off it. */
  code: string
  message: string;
  /** 1-based line number in the file, when the problem is line-local. */
  line?: number;
}

export interface OutputFileValidationResult {
  valid: boolean;
  issues: OutputFileIssue[];
  /** Data-line counts per segment, for the transfer record and the UI summary. */
  counts: Record<string, number>;
  fileCheckValue: string | null;
}

interface ParsedSegment {
  key: SegmentKey;
  /** 1-based line number of the segment title. */
  titleLine: number;
  rows: { line: number; text: string }[];
}

const TITLE_TO_KEY = new Map<string, SegmentKey>(
  (Object.entries(SEGMENT_TITLES) as [SegmentKey, string][]).map(([k, title]) => [title, k]),
);

/** Splits the file into its Appendix A segments, keeping physical line numbers. */
export function parseOutputFile(csv: string): ParsedSegment[] {
  const lines = csv.split(/\r\n|\n/);
  const segments: ParsedSegment[] = [];
  lines.forEach((text, idx) => {
    const lineNo = idx + 1;
    const key = TITLE_TO_KEY.get(text);
    if (key) {
      segments.push({ key, titleLine: lineNo, rows: [] });
      return;
    }
    if (text === '') return;
    segments[segments.length - 1]?.rows.push({ line: lineNo, text });
  });
  return segments;
}

 
export function validateOutputFile(csv: string): OutputFileValidationResult {
  const issues: OutputFileIssue[] = [];
  const counts: Record<string, number> = {};
  let fileCheck: string | null = null;

  if (!csv.endsWith(LINE_TERMINATOR)) {
    issues.push({ code: 'MISSING_FINAL_TERMINATOR', message: 'File must end with a CRLF line terminator.' });
  }

  const segments = parseOutputFile(csv);
  const found = segments.map((s) => s.key);

  // --- segment presence and order (tz.md §10.2) -----------------------------
  for (const key of SEGMENT_ORDER) {
    if (!found.includes(key)) {
      issues.push({ code: 'MISSING_SEGMENT', message: `Segment "${SEGMENT_TITLES[key]}" is missing.` });
    }
  }
  const orderOfFound = found.filter((k) => SEGMENT_ORDER.includes(k));
  const expectedOrder = SEGMENT_ORDER.filter((k) => orderOfFound.includes(k));
  if (orderOfFound.join('|') !== expectedOrder.join('|')) {
    issues.push({
      code: 'SEGMENT_ORDER',
      message: `Segments out of Appendix A order: got ${orderOfFound.join(' -> ')}, expected ${expectedOrder.join(' -> ')}.`,
    });
  }

  const lineCheckValues: string[] = [];

  for (const segment of segments) {
    counts[segment.key] = segment.rows.length;

    if (segment.key === 'endOfFile') {
      if (segment.rows.length !== 1) {
        issues.push({
          code: 'FILE_CHECK_VALUE_MISSING',
          message: `End of file segment must hold exactly one file data check value, found ${segment.rows.length}.`,
          line: segment.titleLine,
        });
      } else {
        fileCheck = segment.rows[0].text.trim();
        if (!/^[0-9A-F]{4}$/.test(fileCheck)) {
          issues.push({
            code: 'FILE_CHECK_VALUE_FORMAT',
            message: `File data check value "${fileCheck}" is not 4 uppercase hex digits (Appendix A 7.27).`,
            line: segment.rows[0].line,
          });
        }
      }
      continue;
    }

    // Every data line must carry a valid Appendix A 4.4.5.2 line data check value.
    for (const row of segment.rows) {
      if (!verifyDataLine(row.text)) {
        issues.push({
          code: 'LINE_CHECK_VALUE',
          message: `Line data check value does not match the line payload.`,
          line: row.line,
        });
      }
      lineCheckValues.push(splitDataLine(row.text).checkValue);
      if (/[^\x20-\x7E]/.test(row.text)) {
        issues.push({ code: 'NON_ASCII', message: 'Data line contains non-printable characters.', line: row.line });
      }
    }

    // Column arity.
    if (segment.key === 'header') {
      if (segment.rows.length !== HEADER_LINES.length) {
        issues.push({
          code: 'HEADER_LINE_COUNT',
          message: `Header segment must have exactly ${HEADER_LINES.length} lines, found ${segment.rows.length}.`,
          line: segment.titleLine,
        });
      }
      segment.rows.forEach((row, idx) => {
        const expected = HEADER_LINES[idx];
        if (!expected) return;
        const { fields } = splitDataLine(row.text);
        if (fields.length !== expected.length) {
          issues.push({
            code: 'HEADER_FIELD_COUNT',
            message: `Header line ${idx + 1} must have ${expected.length} fields (${expected.join(', ')}), found ${fields.length}.`,
            line: row.line,
          });
        }
      });
      validateHeaderValues(segment, issues);
      continue;
    }

    const columns = LIST_COLUMNS[segment.key];
    for (const row of segment.rows) {
      const { fields } = splitDataLine(row.text);
      if (fields.length !== columns.length) {
        issues.push({
          code: 'FIELD_COUNT',
          message: `${SEGMENT_TITLES[segment.key]} line must have ${columns.length} fields, found ${fields.length}.`,
          line: row.line,
        });
      }
    }

    if (segment.key === 'events' || segment.key === 'unidentified') {
      validateEventRows(segment, issues);
    }
    if (segment.key === 'enginePower') {
      validatePositions(segment, issues, 6);
    }
  }

  // --- file data check value ------------------------------------------------
  if (fileCheck !== null) {
    const expected = fileDataCheckValue(lineCheckValues);
    if (expected !== fileCheck) {
      issues.push({
        code: 'FILE_CHECK_VALUE',
        message: `File data check value ${fileCheck} does not match the line check values (${expected}, Appendix A 4.4.5.3).`,
      });
    }
  }

  return { valid: issues.length === 0, issues, counts, fileCheckValue: fileCheck };
}

function validateHeaderValues(segment: ParsedSegment, issues: OutputFileIssue[]): void {
  const fieldsOf = (idx: number): { fields: string[]; line: number } | null => {
    const row = segment.rows[idx];
    return row ? { fields: splitDataLine(row.text).fields, line: row.line } : null;
  };

  // 4.8.2.1.1 line 1: the driver's last name and licence number feed the file name (4.8.2.2).
  const driverLine = fieldsOf(HEADER_LINE.driver);
  if (driverLine) {
    if (!driverLine.fields[0]) {
      issues.push({ code: 'DRIVER_LAST_NAME_MISSING', message: "Driver's last name is required.", line: driverLine.line });
    }
    if (!driverLine.fields[4]) {
      issues.push({
        code: 'DRIVER_LICENSE_MISSING',
        message: "Driver's license number is required (it feeds the file name, 4.8.2.2).",
        line: driverLine.line,
      });
    }
  }

  // Line 4: multiday basis 7/8 (7.36), 24-hour period start HHMMSS (7.1), time zone offset 2 digits (7.41).
  const carrierLine = fieldsOf(HEADER_LINE.carrier);
  if (carrierLine) {
    const [, , basis, periodStart, offset] = carrierLine.fields;
    if (basis !== '7' && basis !== '8') {
      issues.push({ code: 'MULTIDAY_BASIS', message: `Multiday basis must be 7 or 8, got "${basis ?? ''}".`, line: carrierLine.line });
    }
    if (!/^([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]$/.test(periodStart ?? '')) {
      issues.push({
        code: 'PERIOD_START_TIME_FORMAT',
        message: `24-Hour Period Starting Time "${periodStart ?? ''}" must be HHMMSS (7.1).`,
        line: carrierLine.line,
      });
    }
    if (!/^[0-9]{2}$/.test(offset ?? '')) {
      issues.push({
        code: 'TIME_ZONE_OFFSET_FORMAT',
        message: `Time Zone Offset from UTC "${offset ?? ''}" must be 2 digits, sign omitted (7.41).`,
        line: carrierLine.line,
      });
    }
  }

  // Line 5: exempt driver configuration `E` or `0` (7.26).
  const shippingLine = fieldsOf(HEADER_LINE.shipping);
  if (shippingLine && !['E', '0'].includes(shippingLine.fields[1] ?? '')) {
    issues.push({
      code: 'EXEMPT_DRIVER_CONFIGURATION',
      message: `Exempt Driver Configuration must be "E" or "0" (7.26), got "${shippingLine.fields[1] ?? ''}".`,
      line: shippingLine.line,
    });
  }

  // Line 6: current date / time / position.
  const currentLine = fieldsOf(HEADER_LINE.current);
  if (currentLine) {
    const [date, time, lat, lon] = currentLine.fields;
    checkDateTime(date, time, currentLine.line, issues);
    checkPosition(lat, lon, currentLine.line, issues);
  }

  // Line 7: ELD Registration ID, ELD Identifier, ELD Authentication Value, Output File Comment.
  const eldLine = fieldsOf(HEADER_LINE.eld);
  if (eldLine) {
    const [registrationId, identifier, , comment] = eldLine.fields;
    if (identifier === undefined || identifier.length !== ELD_IDENTIFIER_LENGTH) {
      issues.push({
        code: 'ELD_IDENTIFIER_LENGTH',
        message: `ELD Identifier must be exactly ${ELD_IDENTIFIER_LENGTH} characters (7.15), got "${identifier ?? ''}".`,
        line: eldLine.line,
      });
    }
    if (registrationId !== undefined && registrationId !== '' && registrationId.length !== ELD_REGISTRATION_ID_LENGTH) {
      issues.push({
        code: 'ELD_REGISTRATION_ID_LENGTH',
        message: `ELD Registration ID must be exactly ${ELD_REGISTRATION_ID_LENGTH} characters (7.17), got "${registrationId}".`,
        line: eldLine.line,
      });
    }
    if ((comment ?? '').length > OUTPUT_FILE_COMMENT_MAX) {
      issues.push({
        code: 'OUTPUT_FILE_COMMENT_TOO_LONG',
        message: `Output file comment exceeds ${OUTPUT_FILE_COMMENT_MAX} characters.`,
        line: eldLine.line,
      });
    }
  }
}

function checkDateTime(date: string | undefined, time: string | undefined, line: number, issues: OutputFileIssue[]): void {
  if (!/^(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{2}$/.test(date ?? '')) {
    issues.push({ code: 'EVENT_DATE_FORMAT', message: `Date "${date ?? ''}" must be MMDDYY (7.8).`, line });
  }
  if (!/^([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]$/.test(time ?? '')) {
    issues.push({ code: 'EVENT_TIME_FORMAT', message: `Time "${time ?? ''}" must be HHMMSS (7.40).`, line });
  }
}

const LATITUDE = /^-?[0-9]{1,2}\.[0-9]{1,2}$/;
const LONGITUDE = /^-?[0-9]{1,3}\.[0-9]{1,2}$/;

/** Appendix A 7.31 / 7.33 — `X`, `M`, `E` (both fields alike, 4.6.1.4) or decimal degrees. */
function checkPosition(lat: string | undefined, lon: string | undefined, line: number, issues: OutputFileIssue[]): void {
  const marker = (v: string | undefined): boolean => v === 'X' || v === 'M' || v === 'E';
  if (marker(lat) || marker(lon)) {
    if (lat !== lon) {
      issues.push({ code: 'POSITION_MARKER_MISMATCH', message: `Latitude/longitude markers must match, got "${lat}","${lon}".`, line });
    }
    return;
  }
  if (!LATITUDE.test(lat ?? '') || Math.abs(Number(lat)) > 90) {
    issues.push({ code: 'LATITUDE_FORMAT', message: `Latitude "${lat ?? ''}" is not X, M, E or -90.00..90.00 (7.31).`, line });
  }
  if (!LONGITUDE.test(lon ?? '') || Number(lon) > 180 || Number(lon) < -179.99) {
    issues.push({ code: 'LONGITUDE_FORMAT', message: `Longitude "${lon ?? ''}" is not X, M, E or -179.99..180.00 (7.33).`, line });
  }
}

function validatePositions(segment: ParsedSegment, issues: OutputFileIssue[], latIndex: number): void {
  for (const row of segment.rows) {
    const fields = splitDataLine(row.text).fields;
    checkPosition(fields[latIndex], fields[latIndex + 1], row.line, issues);
  }
}

/** Appendix A 4.8.2.1.4 / 4.8.2.1.10 rows (same leading 13 columns). */
function validateEventRows(segment: ParsedSegment, issues: OutputFileIssue[]): void {
  for (const row of segment.rows) {
    const fields = splitDataLine(row.text).fields;
    const [sequenceId, recordStatus, recordOrigin, eventType, eventCode, date, time] = fields;
    if (!/^[0-9A-F]{1,4}$/.test(sequenceId ?? '')) {
      issues.push({
        code: 'EVENT_SEQUENCE_ID_FORMAT',
        message: `Event Sequence ID "${sequenceId ?? ''}" must be 1-4 hex digits 0..FFFF (7.24).`,
        line: row.line,
      });
    }
    for (const [name, value, min, max] of [
      ['Event Record Status', recordStatus, 1, 4],
      ['Event Record Origin', recordOrigin, 1, 4],
      ['Event Type', eventType, 1, 7],
      ['Event Code', eventCode, 0, 9],
    ] as [string, string | undefined, number, number][]) {
      const n = Number(value);
      if (!/^[0-9]$/.test(value ?? '') || n < min || n > max) {
        issues.push({ code: 'EVENT_FIELD_RANGE', message: `${name} "${value ?? ''}" is out of Appendix A range ${min}..${max}.`, line: row.line });
      }
    }
    checkDateTime(date, time, row.line, issues);
    checkPosition(fields[9], fields[10], row.line, issues);
    const distance = fields[11] ?? '';
    if (!/^[0-9]$/.test(distance) || Number(distance) > DISTANCE_SINCE_LAST_VALID_MAX) {
      issues.push({
        code: 'DISTANCE_SINCE_LAST_VALID_RANGE',
        message: `Distance Since Last Valid Coordinates "${distance}" must be 0..${DISTANCE_SINCE_LAST_VALID_MAX} (7.9).`,
        line: row.line,
      });
    }
    const eventCheck = fields[fields.length - 1] ?? '';
    if (!/^[0-9A-F]{2}$/.test(eventCheck)) {
      issues.push({
        code: 'EVENT_DATA_CHECK_VALUE_FORMAT',
        message: `Event Data Check Value "${eventCheck}" must be 2 uppercase hex digits (7.21).`,
        line: row.line,
      });
    }
  }
}
