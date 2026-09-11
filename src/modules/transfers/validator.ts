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
  ELD_IDENTIFIER_LENGTH,
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
        if (!/^[0-9A-F]{2}$/.test(fileCheck)) {
          issues.push({
            code: 'FILE_CHECK_VALUE_FORMAT',
            message: `File data check value "${fileCheck}" is not 2 uppercase hex digits.`,
            line: segment.rows[0].line,
          });
        }
      }
      continue;
    }

    // Every data line must carry a valid Appendix A 4.4.5.3 check value.
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
  }

  // --- file data check value ------------------------------------------------
  if (fileCheck !== null) {
    const expected = fileDataCheckValue(lineCheckValues);
    if (expected !== fileCheck) {
      issues.push({
        code: 'FILE_CHECK_VALUE',
        message: `File data check value ${fileCheck} does not match the sum of line check values (${expected}).`,
      });
    }
  }

  return { valid: issues.length === 0, issues, counts, fileCheckValue: fileCheck };
}

function validateHeaderValues(segment: ParsedSegment, issues: OutputFileIssue[]): void {
  // Header line 8: ELD Registration ID, ELD Identifier, ELD Authentication Value.
  const idLine = segment.rows[7];
  if (idLine) {
    const { fields } = splitDataLine(idLine.text);
    const [registrationId, identifier] = fields;
    if (identifier === undefined || identifier.length !== ELD_IDENTIFIER_LENGTH) {
      issues.push({
        code: 'ELD_IDENTIFIER_LENGTH',
        message: `ELD Identifier must be exactly ${ELD_IDENTIFIER_LENGTH} characters (Appendix A), got "${identifier ?? ''}".`,
        line: idLine.line,
      });
    }
    if (registrationId !== undefined && registrationId !== '' && registrationId.length !== ELD_IDENTIFIER_LENGTH) {
      issues.push({
        code: 'ELD_REGISTRATION_ID_LENGTH',
        message: `ELD Registration ID must be exactly ${ELD_IDENTIFIER_LENGTH} characters, got "${registrationId}".`,
        line: idLine.line,
      });
    }
  }
  // Header line 1: the driver's last name is what the file name is built from.
  const driverLine = segment.rows[0];
  if (driverLine) {
    const { fields } = splitDataLine(driverLine.text);
    if (!fields[0]) {
      issues.push({ code: 'DRIVER_LAST_NAME_MISSING', message: "Driver's last name is required.", line: driverLine.line });
    }
    if (!fields[4]) {
      issues.push({
        code: 'DRIVER_LICENSE_MISSING',
        message: "Driver's license number is required (it feeds the file name, 4.8.2.2).",
        line: driverLine.line,
      });
    }
  }
  // Header line 9: output file comment, max 60.
  const commentLine = segment.rows[8];
  if (commentLine) {
    const { fields } = splitDataLine(commentLine.text);
    if ((fields[0] ?? '').length > OUTPUT_FILE_COMMENT_MAX) {
      issues.push({
        code: 'OUTPUT_FILE_COMMENT_TOO_LONG',
        message: `Output file comment exceeds ${OUTPUT_FILE_COMMENT_MAX} characters.`,
        line: commentLine.line,
      });
    }
  }
}

function validateEventRows(segment: ParsedSegment, issues: OutputFileIssue[]): void {
  for (const row of segment.rows) {
    const [sequenceId, recordStatus, recordOrigin, eventType, eventCode, date, time] = splitDataLine(row.text).fields;
    if (!/^[0-9A-F]{4}$/.test(sequenceId ?? '')) {
      issues.push({
        code: 'EVENT_SEQUENCE_ID_FORMAT',
        message: `Event Sequence ID "${sequenceId ?? ''}" must be 4 hex digits 0001..FFFF.`,
        line: row.line,
      });
    }
    if (sequenceId === '0000') {
      issues.push({ code: 'EVENT_SEQUENCE_ID_RANGE', message: 'Event Sequence ID 0000 is not allowed.', line: row.line });
    }
    for (const [name, value, max] of [
      ['Event Record Status', recordStatus, 4],
      ['Event Record Origin', recordOrigin, 4],
      ['Event Type', eventType, 7],
      ['Event Code', eventCode, 9],
    ] as [string, string | undefined, number][]) {
      const n = Number(value);
      if (!/^[0-9]$/.test(value ?? '') || n < 0 || n > max) {
        issues.push({ code: 'EVENT_FIELD_RANGE', message: `${name} "${value ?? ''}" is out of Appendix A range 0..${max}.`, line: row.line });
      }
    }
    if (!/^[0-1][0-9][0-3][0-9][0-9]{2}$/.test(date ?? '')) {
      issues.push({ code: 'EVENT_DATE_FORMAT', message: `Event Date "${date ?? ''}" must be MMDDYY.`, line: row.line });
    }
    if (!/^([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]$/.test(time ?? '')) {
      issues.push({ code: 'EVENT_TIME_FORMAT', message: `Event Time "${time ?? ''}" must be HHMMSS.`, line: row.line });
    }
  }
}
