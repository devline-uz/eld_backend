/**
 * The eRODS output file layout, declared ONCE — 49 CFR §395 Subpart B Appendix A 4.8.2.1.
 *
 * `output-file.ts` renders from this table and `validator.ts` re-parses against it, so the
 * generator and the validator can never drift apart.
 *
 * Diffed column by column against the official eCFR text (2026-10-06 revision, kept verbatim
 * in `docs/fmcsa/49cfr395-subpartB-appendixA.txt`) on 2026-10-08 — decisions.md D-024 is
 * closed by that diff. Segment ORDER is the order of sections 4.8.2.1.1 .. 4.8.2.1.11:
 *
 *   Header -> User list -> CMV list -> ELD Event list -> Annotations/comments ->
 *   Certification list -> Malfunction/diagnostic list -> Login/logout report ->
 *   Engine power-up/shut-down list -> Unidentified driver list -> End of file.
 *
 * Every data line (header lines included) ends with a Line Data Check Value (4.4.5.2.3) which
 * is NOT listed in the column tables below; the generator appends it. Event list and
 * unidentified rows additionally carry an Event Data Check Value (4.4.5.1, 7.21) as their last
 * DATA column, and that one IS listed.
 */

export const SEGMENT_TITLES = {
  header: 'ELD File Header Segment:', // 4.8.2.1.1
  users: 'User List:', // 4.8.2.1.2
  cmvs: 'CMV List:', // 4.8.2.1.3
  events: 'ELD Event List:', // 4.8.2.1.4
  annotations: 'ELD Event Annotations or Comments:', // 4.8.2.1.5
  certifications: "Driver's Certification/Recertification Actions:", // 4.8.2.1.6
  malfunctions: 'Malfunctions and Data Diagnostic Events:', // 4.8.2.1.7
  loginLogout: 'ELD Login/Logout Report:', // 4.8.2.1.8
  enginePower: 'CMV Engine Power-Up and Shut Down Activity:', // 4.8.2.1.9
  unidentified: 'Unidentified Driver Profile Records:', // 4.8.2.1.10
  endOfFile: 'End of File:', // 4.8.2.1.11
} as const;

export type SegmentKey = keyof typeof SEGMENT_TITLES;

/** Segment order as it must appear in the file (Appendix A 4.8.2.1.1 .. 4.8.2.1.11). */
export const SEGMENT_ORDER: readonly SegmentKey[] = [
  'header',
  'users',
  'cmvs',
  'events',
  'annotations',
  'certifications',
  'malfunctions',
  'loginLogout',
  'enginePower',
  'unidentified',
  'endOfFile',
] as const;

/**
 * Appendix A 4.8.2.1.1 — the header segment is a FIXED sequence of 7 lines, each with its own
 * column list (Line Data Check Value not listed).
 */
export const HEADER_LINES: readonly (readonly string[])[] = [
  ["Driver's Last Name", "Driver's First Name", 'ELD Username (driver)', "Driver's License Issuing State", "Driver's License Number"],
  ["Co-Driver's Last Name", "Co-Driver's First Name", 'ELD Username (co-driver)'],
  ['CMV Power Unit Number', 'CMV VIN', 'Trailer Number(s)'],
  ["Carrier's USDOT Number", 'Carrier Name', 'Multiday Basis Used', '24-Hour Period Starting Time', 'Time Zone Offset from UTC'],
  ['Shipping Document Number', 'Exempt Driver Configuration'],
  ['Current Date', 'Current Time', 'Current Latitude', 'Current Longitude', 'Current Total Vehicle Miles', 'Current Total Engine Hours'],
  ['ELD Registration ID', 'ELD Identifier', 'ELD Authentication Value', 'Output File Comment'],
] as const;

/** 0-based header line indexes, so the validator never hard-codes magic numbers. */
export const HEADER_LINE = {
  driver: 0,
  coDriver: 1,
  cmv: 2,
  carrier: 3,
  shipping: 4,
  current: 5,
  eld: 6,
} as const;

/** Appendix A 4.8.2.1.2 .. 4.8.2.1.10 — data columns of every repeating segment. */
export const LIST_COLUMNS = {
  // 4.8.2.1.2 — NO username column in the user list.
  users: ['Order Number', 'ELD Account Type', 'Last Name', 'First Name'],
  // 4.8.2.1.3
  cmvs: ['Order Number', 'CMV Power Unit Number', 'CMV VIN'],
  // 4.8.2.1.4 — event types 1, 2, 3 only.
  events: [
    'Event Sequence ID Number',
    'Event Record Status',
    'Event Record Origin',
    'Event Type',
    'Event Code',
    'Event Date',
    'Event Time',
    'Accumulated Vehicle Miles',
    'Elapsed Engine Hours',
    'Event Latitude',
    'Event Longitude',
    'Distance Since Last Valid Coordinates',
    'Corresponding CMV Order Number',
    'User Order Number (Record Originator)',
    'Malfunction Indicator Status',
    'Data Diagnostic Event Indicator Status',
    'Event Data Check Value',
  ],
  // 4.8.2.1.5 — 2nd field is the record originator's ELD USERNAME, not an order number.
  annotations: [
    'Event Sequence ID Number',
    'ELD Username (Record Originator)',
    'Comment Text or Annotation',
    'Event Date',
    'Event Time',
    "Driver's Location Description",
  ],
  // 4.8.2.1.6
  certifications: [
    'Event Sequence ID Number',
    'Event Code',
    'Event Date',
    'Event Time',
    'Date of the Certified Record',
    'Corresponding CMV Order Number',
  ],
  // 4.8.2.1.7
  malfunctions: [
    'Event Sequence ID Number',
    'Event Code',
    'Malfunction/Diagnostic Code',
    'Event Date',
    'Event Time',
    'Total Vehicle Miles',
    'Total Engine Hours',
    'Corresponding CMV Order Number',
  ],
  // 4.8.2.1.8 — event type 5.
  loginLogout: [
    'Event Sequence ID Number',
    'Event Code',
    'ELD Username',
    'Event Date',
    'Event Time',
    'Total Vehicle Miles',
    'Total Engine Hours',
  ],
  // 4.8.2.1.9 — event type 6.
  enginePower: [
    'Event Sequence ID Number',
    'Event Code',
    'Event Date',
    'Event Time',
    'Total Vehicle Miles',
    'Total Engine Hours',
    'Event Latitude',
    'Event Longitude',
    'CMV Power Unit Number',
    'CMV VIN',
    'Trailer Number(s)',
    'Shipping Document Number',
  ],
  // 4.8.2.1.10 — no user order number and no diagnostic indicator; malfunction indicator kept.
  unidentified: [
    'Event Sequence ID Number',
    'Event Record Status',
    'Event Record Origin',
    'Event Type',
    'Event Code',
    'Event Date',
    'Event Time',
    'Accumulated Vehicle Miles',
    'Elapsed Engine Hours',
    'Event Latitude',
    'Event Longitude',
    'Distance Since Last Valid Coordinates',
    'Corresponding CMV Order Number',
    'Malfunction Indicator Status',
    'Event Data Check Value',
  ],
} as const satisfies Record<Exclude<SegmentKey, 'header' | 'endOfFile'>, readonly string[]>;

/** Event types allowed in the ELD Event List (4.8.2.1.4): duty status, intermediate, PC/YM. */
export const EVENT_LIST_TYPES: readonly number[] = [1, 2, 3];
export const LOGIN_LOGOUT_EVENT_TYPE = 5;
export const ENGINE_POWER_EVENT_TYPE = 6;

/**
 * Appendix A 7.15 — the ELD Identifier is exactly SIX characters of [A-Z0-9] (provider-coded,
 * e.g. `1001ZE`); 7.17 — the ELD Registration ID is exactly FOUR (FMCSA-issued, e.g. `ZA10`).
 * Mirrored by `Carrier.eldIdentifier` VarChar(6) + CHECK `eld_identifier_format` and
 * `EldIdentifierSchema` (bugs.md B-138, migration 20261008130000_eld_identifier_six_chars).
 */
export const ELD_IDENTIFIER_LENGTH = 6;
export const ELD_REGISTRATION_ID_LENGTH = 4;
/** Appendix A 4.3.2.5 / 7.38 — output file comment, 0-60 characters. */
export const OUTPUT_FILE_COMMENT_MAX = 60;
/** Appendix A 7.6 — comment/annotation, max 60 characters. */
export const ANNOTATION_MAX = 60;
/** Appendix A 7.12 — Driver's Location Description, 5-60 characters. */
export const LOCATION_DESCRIPTION_MAX = 60;
/** Appendix A 7.9 — Distance Since Last Valid Coordinates is 0..6; anything above is written as 6. */
export const DISTANCE_SINCE_LAST_VALID_MAX = 6;
/** Appendix A 7.1 — OneBook RODS days start at home-terminal midnight. */
export const DEFAULT_PERIOD_START_TIME = '000000';

/**
 * Appendix A 4.1.5 / 4.8.2.1.2 / 7.13 — the Unidentified Driver profile. It is listed in the
 * user list as account type `D`, and its ELD username feeds the Event Data Check Value of every
 * unidentified record (4.4.5.1.1(b)(10)).
 */
export const UNIDENTIFIED_PROFILE = {
  username: 'unidentified',
  lastName: 'Unidentified',
  firstName: 'Driver',
  accountType: 'D',
} as const;
