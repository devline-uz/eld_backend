/**
 * Appendix A section 7 — the eRODS output file layout, declared ONCE.
 *
 * `output-file.ts` renders from this table and `validator.ts` re-parses against it, so the
 * generator and the validator can never drift apart. Segment ORDER is normative (tz.md §10.2):
 *
 *   Header -> User list -> CMV list -> Malfunction/diagnostic list -> Event list ->
 *   Annotation/comment list -> Certification list -> Unidentified driving list ->
 *   File data check value.
 *
 * NOTE (open question #2, tasks.md): the segment ORDER, the character set, the per-line check
 * value and the file data check value are settled. The exact COLUMN ORDER inside the data
 * lines is transcribed from Appendix A section 7 and still needs a last diff against the
 * current FMCSA document revision before the PRODUCTION toggle is flipped. Because both the
 * writer and the reader come from this one table, that diff is a single-file edit.
 */

export const SEGMENT_TITLES = {
  header: 'ELD File Header Segment:',
  users: 'User List:',
  cmvs: 'CMV List:',
  malfunctions: 'ELD Malfunction and Data Diagnostic Event Records:',
  events: 'ELD Event List:',
  annotations: 'ELD Event Annotations or Comments:',
  certifications: "Driver's Certification/Recertification Actions:",
  unidentified: 'Unidentified Driver Profile Records:',
  endOfFile: 'End of File:',
} as const;

export type SegmentKey = keyof typeof SEGMENT_TITLES;

/** Segment order as it must appear in the file. */
export const SEGMENT_ORDER: readonly SegmentKey[] = [
  'header',
  'users',
  'cmvs',
  'malfunctions',
  'events',
  'annotations',
  'certifications',
  'unidentified',
  'endOfFile',
] as const;

/**
 * The header segment is a FIXED sequence of 9 lines, each with its own column list. Every
 * other segment is a repeating list of identically-shaped lines.
 */
export const HEADER_LINES: readonly (readonly string[])[] = [
  ["Driver's Last Name", "Driver's First Name", "Driver's ELD Username", "Driver's License Issuing State", "Driver's License Number"],
  ["Co-Driver's Last Name", "Co-Driver's First Name", "Co-Driver's ELD Username"],
  ['CMV Power Unit Number', 'CMV VIN', 'Trailer Number(s)'],
  ["Carrier's USDOT Number", 'Carrier Name', 'Multiday Basis Used'],
  ['Shipping Document Number'],
  ['Exempt Driver Configuration'],
  ['Time Zone Offset from UTC', 'Current Date', 'Current Time'],
  ['ELD Registration ID', 'ELD Identifier', 'ELD Authentication Value'],
  ['Output File Comment'],
] as const;

export const LIST_COLUMNS = {
  users: ['User Order Number', 'ELD Username', "Driver's Last Name", "Driver's First Name", 'ELD Account Type'],
  cmvs: ['CMV Order Number', 'CMV Power Unit Number', 'CMV VIN'],
  malfunctions: [
    'Event Sequence ID Number',
    'Event Code',
    'Malfunction/Diagnostic Code',
    'Event Date',
    'Event Time',
    'Total Vehicle Miles',
    'Total Engine Hours',
    'CMV Order Number',
  ],
  events: [
    'Event Sequence ID Number',
    'Event Record Status',
    'Event Record Origin',
    'Event Type',
    'Event Code',
    'Event Date',
    'Event Time',
    'Total Vehicle Miles',
    'Total Engine Hours',
    'Event Latitude',
    'Event Longitude',
    'Distance Since Last Valid Coordinates',
    'CMV Order Number',
    'User Order Number',
    'Malfunction Indicator Status',
    'Data Diagnostic Event Indicator Status',
  ],
  annotations: [
    'Event Sequence ID Number',
    'User Order Number',
    'Annotation/Comment Text',
    'Event Date',
    'Event Time',
    "Driver's Location Description",
  ],
  certifications: ['Event Sequence ID Number', 'Event Code', 'Event Date', 'Event Time', 'Date of the Certified Record'],
  unidentified: [
    'Event Sequence ID Number',
    'Event Record Status',
    'Event Record Origin',
    'Event Type',
    'Event Code',
    'Event Date',
    'Event Time',
    'Total Vehicle Miles',
    'Total Engine Hours',
    'Event Latitude',
    'Event Longitude',
    'Distance Since Last Valid Coordinates',
    'CMV Order Number',
  ],
} as const satisfies Record<Exclude<SegmentKey, 'header' | 'endOfFile'>, readonly string[]>;

/** Appendix A: exactly 4 characters, `[A-Z0-9]`. A 6-char value invalidates the file. */
export const ELD_IDENTIFIER_LENGTH = 4;
/** tz.md §10.3 — `outputFileComment` is capped at 60 characters. */
export const OUTPUT_FILE_COMMENT_MAX = 60;
/** §395 Appendix A — annotations are capped at 60 characters. */
export const ANNOTATION_MAX = 60;
/** §395 Appendix A 4.3.2.7 / 7.12 — a manually entered location description is 5-60 characters. */
export const LOCATION_DESCRIPTION_MAX = 60;
