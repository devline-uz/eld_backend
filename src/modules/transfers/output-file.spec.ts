import { eventDataCheckValue, verifyDataLine } from './check-value';
import { fixtureEvent, fixtureOutputFileInput } from './output-file.fixture';
import {
  buildOutputFile,
  csvField,
  formatCoordinate,
  formatDistanceSinceLastValid,
  formatEngineHours,
  formatEventDate,
  formatEventPosition,
  formatEventTime,
  formatMiles,
  formatSequenceId,
  formatTimeZoneOffset,
} from './output-file';
import { SEGMENT_ORDER, SEGMENT_TITLES } from './segments';
import { validateOutputFile } from './validator';

describe('Appendix A field formatters', () => {
  it('formats the event date as MMDDYY in home-terminal time', () => {
    // 2026-09-04T02:30:00Z is still 2026-09-03 22:30 in EDT (UTC-4).
    expect(formatEventDate(new Date('2026-09-04T02:30:00Z'), -240)).toBe('090326');
    expect(formatEventTime(new Date('2026-09-04T02:30:00Z'), -240)).toBe('223000');
  });

  it('formats the time-zone offset as 2 digits, sign omitted (7.41)', () => {
    expect(formatTimeZoneOffset(-240)).toBe('04');
    expect(formatTimeZoneOffset(-300)).toBe('05');
    expect(formatTimeZoneOffset(-600)).toBe('10');
  });

  it('renders the event sequence id as hex 0..FFFF and wraps FFFF -> 0 (7.24)', () => {
    expect(formatSequenceId(1)).toBe('0001');
    expect(formatSequenceId(255)).toBe('00FF');
    expect(formatSequenceId(65535)).toBe('FFFF');
    expect(formatSequenceId(65536)).toBe('0000');
    expect(formatSequenceId(0)).toBe('0000');
  });

  it('uses 0.01 degree resolution normally and 0.1 degree for a 10-mile (PC) record', () => {
    expect(formatCoordinate(41.318511, 1)).toBe('41.32');
    expect(formatCoordinate(-72.928932, 1)).toBe('-72.93');
    expect(formatCoordinate(41.318511, 10)).toBe('41.3');
    expect(formatCoordinate(null, 1)).toBe('');
    expect(formatCoordinate(-0.001, 1)).toBe('0.00');
    expect(formatCoordinate(-0.04, 10)).toBe('0.0');
    expect(formatCoordinate(-0.006, 1)).toBe('-0.01');
  });

  it('writes the position markers: E (4.6.1.4(e)) > fix > M (4.3.2.7(c), 4.6.1.4(d)) > X (4.6.1.4(d))', () => {
    expect(formatEventPosition(fixtureEvent())).toEqual(['41.32', '-72.93']);
    expect(formatEventPosition(fixtureEvent({ locationPrecisionMi: 10 }))).toEqual(['41.3', '-72.9']);
    const noFix = { latitude: null, longitude: null };
    expect(formatEventPosition(fixtureEvent({ ...noFix, locationDescription: 'Pilot Truck Stop, Exit 12' }))).toEqual(['M', 'M']);
    expect(formatEventPosition(fixtureEvent(noFix))).toEqual(['X', 'X']);
    expect(formatEventPosition(fixtureEvent({ ...noFix, locationDescription: '   ' }))).toEqual(['X', 'X']);
    // Half a position is no position.
    expect(formatEventPosition(fixtureEvent({ longitude: null }))).toEqual(['X', 'X']);
    // 4.6.1.4(e): E wins even when the driver typed a location.
    expect(
      formatEventPosition(fixtureEvent({ ...noFix, locationDescription: 'Yard', positioningMalfunction: true })),
    ).toEqual(['E', 'E']);
    expect(formatEventPosition(fixtureEvent({ positioningMalfunction: true }))).toEqual(['E', 'E']);
  });

  it('leaves unknown miles / engine hours empty instead of inventing a zero', () => {
    expect(formatMiles(null)).toBe('');
    expect(formatMiles(120_345.9)).toBe('120345');
    expect(formatEngineHours(null)).toBe('');
    expect(formatEngineHours(4321.44)).toBe('4321.4');
  });

  it('caps Distance Since Last Valid Coordinates at 6 and writes 0 when unknown (7.9)', () => {
    expect(formatDistanceSinceLastValid(0)).toBe('0');
    expect(formatDistanceSinceLastValid(4.9)).toBe('4');
    expect(formatDistanceSinceLastValid(6)).toBe('6');
    expect(formatDistanceSinceLastValid(250)).toBe('6');
    expect(formatDistanceSinceLastValid(null)).toBe('0');
  });

  it('replaces commas and carriage returns with ";" and drops non-ASCII (4.8.2.1(b)(3))', () => {
    expect(csvField('Smith, John\r\nJr')).toBe('Smith; John;Jr');
    expect(csvField('a\rb\nc')).toBe('a;b;c');
    expect(csvField('Ödön')).toBe('dn');
    expect(csvField('a'.repeat(80), 60)).toHaveLength(60);
  });
});

describe('Appendix A output file generator', () => {
  const input = fixtureOutputFileInput();
  const file = buildOutputFile(input);
  const lines = file.csv.split('\r\n').filter((l) => l !== '');
  const segment = (key: keyof typeof SEGMENT_TITLES, csv = file.csv): string[] => {
    const idx = SEGMENT_ORDER.indexOf(key);
    const next = SEGMENT_TITLES[SEGMENT_ORDER[idx + 1]];
    return csv.split(SEGMENT_TITLES[key] + '\r\n')[1].split(next + '\r\n')[0].split('\r\n').filter(Boolean);
  };

  it('emits the eleven segments in Appendix A 4.8.2.1.1 .. 4.8.2.1.11 order', () => {
    const titles = lines.filter((l) => Object.values(SEGMENT_TITLES).includes(l as never));
    expect(titles).toEqual(SEGMENT_ORDER.map((k) => SEGMENT_TITLES[k]));
    expect(titles).toEqual([
      'ELD File Header Segment:',
      'User List:',
      'CMV List:',
      'ELD Event List:',
      'ELD Event Annotations or Comments:',
      "Driver's Certification/Recertification Actions:",
      'Malfunctions and Data Diagnostic Events:',
      'ELD Login/Logout Report:',
      'CMV Engine Power-Up and Shut Down Activity:',
      'Unidentified Driver Profile Records:',
      'End of File:',
    ]);
  });

  it('ends with the 4-hex-digit file data check value and a CRLF (4.8.2.1.11, 7.27)', () => {
    expect(file.csv.endsWith('\r\n')).toBe(true);
    expect(lines.at(-2)).toBe(SEGMENT_TITLES.endOfFile);
    expect(lines.at(-1)).toMatch(/^[0-9A-F]{4}$/);
    expect(lines.at(-1)).toBe(file.fileCheckValue);
  });

  it('puts a valid line data check value on every data line', () => {
    const dataLines = lines.filter(
      (l) => !Object.values(SEGMENT_TITLES).includes(l as never) && l !== file.fileCheckValue,
    );
    expect(dataLines.length).toBeGreaterThan(10);
    for (const line of dataLines) expect(verifyDataLine(line)).toBe(true);
  });

  it('writes the 7-line header of 4.8.2.1.1', () => {
    const header = segment('header');
    expect(header).toHaveLength(7);
    expect(header.map((l) => l.split(',').length - 1)).toEqual([5, 3, 3, 5, 2, 6, 4]);
    expect(header[0].startsWith('Smith,John,jsmith,CT,W8569238,')).toBe(true);
    // Line 4: USDOT, carrier name (comma -> ";"), multiday basis, 24-hour period start, TZ offset.
    expect(header[3].split(',').slice(0, 5)).toEqual(['3355123', 'OneBook Logistics; LLC', '8', '000000', '04']);
    // Line 5: shipping document, exempt configuration `0` (7.26).
    expect(header[4].split(',').slice(0, 2)).toEqual(['BOL-55120', '0']);
    // Line 6: current date/time (EDT), position and totals.
    expect(header[5].split(',').slice(0, 6)).toEqual(['091126', '130405', '41.32', '-72.93', '120400', '4330.2']);
    // Line 7: registration id, identifier, authentication value, comment.
    expect(header[6].split(',').slice(0, 4)).toEqual(['OBK1', 'OBK001', 'A1B2C3D4', 'Roadside inspection I-95 NB mile 48']);
  });

  it('writes X,X and empty totals for the current position when nothing is known', () => {
    const out = buildOutputFile(fixtureOutputFileInput({ current: null }));
    expect(segment('header', out.csv)[5].split(',').slice(2, 6)).toEqual(['X', 'X', '', '']);
  });

  it('REFUSES a malformed ELD identifier / registration id instead of truncating it', () => {
    // §395 Appendix A 7.15: the ELD Identifier is 6 chars; the old 4-char value is refused (B-138).
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldIdentifier: 'OBK1' }))).toThrow(/exactly 6 characters/);
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldIdentifier: 'OBK0001' }))).toThrow(RangeError);
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldIdentifier: 'ob-001' }))).toThrow(RangeError);
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldIdentifier: '1001ZE' }))).not.toThrow();
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldRegistrationId: 'TEST01' }))).toThrow(
      /Registration ID must be exactly 4/,
    );
  });

  it('accepts an empty registration id (not yet issued by FMCSA — TEST mode)', () => {
    const out = buildOutputFile(fixtureOutputFileInput({ eldRegistrationId: '' }));
    expect(validateOutputFile(out.csv).valid).toBe(true);
  });

  it('caps the output file comment at 60 characters', () => {
    const out = buildOutputFile(fixtureOutputFileInput({ outputFileComment: 'C'.repeat(120) }));
    expect(segment('header', out.csv)[6].split(',')[3]).toHaveLength(60);
  });

  it('writes the user list as order, account type, last, first — no username (4.8.2.1.2)', () => {
    expect(segment('users')).toEqual([
      expect.stringMatching(/^1,D,Smith,John,[0-9A-F]{2}$/),
      expect.stringMatching(/^2,S,Ortiz,Maria,[0-9A-F]{2}$/),
      expect.stringMatching(/^3,D,Unidentified,Driver,[0-9A-F]{2}$/),
    ]);
  });

  it('writes the ELD event list most-recent-first with 17 data fields ending in the event data check value', () => {
    const rows = segment('events');
    expect(rows).toHaveLength(7);
    expect(rows.map((l) => l.split(',')[0])).toEqual(['0007', '0006', '0005', '0004', '0003', '0002', '0001']);
    for (const row of rows) expect(row.split(',')).toHaveLength(18);
    const first = rows.at(-1)!.split(',');
    // Accumulated miles / elapsed hours, not the odometer (4.8.2.1.4, 7.43, 7.19).
    expect(first.slice(7, 9)).toEqual(['45', '1.5']);
    expect(first[16]).toBe(
      eventDataCheckValue(['1', '1', '090426', '060000', '45', '1.5', '41.32', '-72.93', '101', 'jsmith']),
    );
    expect(first[16]).toBe('26');
  });

  it('feeds the record ELD username and CMV power unit into the event data check value (4.4.5.1.1)', () => {
    const base = fixtureOutputFileInput();
    const e = fixtureEvent({ sequenceId: 1, eventCode: 1, dateTime: new Date('2026-09-04T10:00:00Z') });
    const check = (o: Partial<typeof base>) => segment('events', buildOutputFile({ ...base, events: [e], ...o }).csv)[0].split(',')[16];
    expect(check({})).toBe('26');
    expect(check({ driver: { ...base.driver, username: 'jsmith2' } })).not.toBe('26');
    expect(check({ cmvs: [{ orderNumber: 1, powerUnitNumber: '102', vin: '' }] })).not.toBe('26');
    // A stored event data check value travels with the record (4.4.5(c)).
    expect(check({ events: [{ ...e, eventDataCheckValue: 'A7' }] })).toBe('A7');
  });

  it('refuses login/logout or engine records in the event list (4.8.2.1.4 holds types 1-3)', () => {
    expect(() =>
      buildOutputFile(fixtureOutputFileInput({ events: [fixtureEvent({ eventType: 5, eventCode: 1 })] })),
    ).toThrow(/loginLogout/);
    expect(() =>
      buildOutputFile(fixtureOutputFileInput({ events: [fixtureEvent({ eventType: 6, eventCode: 1 })] })),
    ).toThrow(/enginePower/);
  });

  it('writes the annotation segment with the originator ELD username, capped at 60 (4.8.2.1.5)', () => {
    const rows = segment('annotations');
    expect(rows).toHaveLength(2);
    // Most recent first: 11:06 (dispatch1) before 11:05 (jsmith).
    expect(rows[0].split(',').slice(0, 2)).toEqual(['0006', 'dispatch1']);
    expect(rows[0].split(',')[2]).toHaveLength(60);
    expect(rows[1].split(',').slice(0, 3)).toEqual(['0006', 'jsmith', "Forgot to switch to ON duty fueling stop; O'Hare"]);
  });

  it("exports a manually located record as M,M plus its Driver's Location Description (4.3.2.7)", () => {
    const base = fixtureOutputFileInput();
    const manual = fixtureEvent({
      sequenceId: 300,
      recordOrigin: 2,
      eventCode: 4,
      latitude: null,
      longitude: null,
      distanceSinceLastValidCoords: 3,
      locationDescription: 'Pilot, Exit 12, Hartford CT',
    });
    const out = buildOutputFile({
      ...base,
      events: [manual],
      annotations: [
        {
          sequenceId: 300,
          username: 'jsmith',
          text: '',
          dateTime: manual.dateTime,
          timezoneOffsetMin: manual.timezoneOffsetMin,
          locationDescription: 'Pilot, Exit 12, Hartford CT',
        },
      ],
    });
    const [eventLine] = segment('events', out.csv);
    expect(eventLine.split(',').slice(9, 12)).toEqual(['M', 'M', '3']);
    expect(verifyDataLine(eventLine)).toBe(true);
    const [annotationLine] = segment('annotations', out.csv);
    expect(annotationLine.split(',')[5]).toBe('Pilot; Exit 12; Hartford CT');
    expect(verifyDataLine(annotationLine)).toBe(true);
    expect(validateOutputFile(out.csv).issues).toEqual([]);
  });

  it('writes X,X for a located record with no position and no typed location', () => {
    const intermediate = segment('events').find((l) => l.startsWith('0007,'));
    expect(intermediate?.split(',').slice(9, 12)).toEqual(['X', 'X', '4']);
  });

  it('keeps superseded (recordStatus 2) and edited (recordOrigin 2) records in the event list', () => {
    const rows = segment('events');
    expect(rows.some((l) => l.split(',')[1] === '2')).toBe(true);
    expect(rows.some((l) => l.split(',')[2] === '2')).toBe(true);
  });

  it('adds the Corresponding CMV Order Number to certification rows (4.8.2.1.6)', () => {
    const rows = segment('certifications');
    expect(rows.map((l) => l.split(',').slice(0, 6))).toEqual([
      ['0029', '9', '090526', '231000', '090526', ''],
      ['0028', '1', '090426', '231000', '090426', '1'],
    ]);
  });

  it('writes the login/logout report with the ELD username (4.8.2.1.8)', () => {
    const rows = segment('loginLogout');
    expect(rows.map((l) => l.split(',').slice(0, 7))).toEqual([
      ['000D', '2', 'jsmith', '090726', '160000', '120345', '4321.4'],
      ['FFFF', '1', 'jsmith', '090726', '040000', '120345', '4321.4'],
    ]);
  });

  it('writes engine power-up / shut-down rows with total miles, position and CMV (4.8.2.1.9)', () => {
    const rows = segment('enginePower');
    expect(rows.map((l) => l.split(',').slice(0, 12))).toEqual([
      ['0065', '3', '090426', '190000', '120345', '4321.4', 'X', 'X', '101', '1FUJGLDR9CSBK1234', '', ''],
      ['0064', '1', '090426', '055500', '120345', '4321.4', '41.32', '-72.93', '101', '1FUJGLDR9CSBK1234', 'TR-88', 'BOL-55120'],
    ]);
  });

  it('lists unidentified records with malfunction indicator and event data check value (4.8.2.1.10)', () => {
    const rows = segment('unidentified');
    expect(rows).toHaveLength(1);
    const fields = rows[0].split(',');
    expect(fields).toHaveLength(16);
    expect(fields[2]).toBe('4');
    expect(fields[13]).toBe('0');
    expect(fields[14]).toBe(
      eventDataCheckValue(['1', '3', '090726', '223000', '45', '1.5', '41.32', '-72.93', '101', 'unidentified']),
    );
  });

  it('is byte-for-byte stable across regenerations (event sequence ids come from ingest)', () => {
    const again = buildOutputFile(fixtureOutputFileInput());
    expect(again.csv).toBe(file.csv);
    expect(again.fileCheckValue).toBe(file.fileCheckValue);
  });

  it('generates an empty-but-valid file when a driver has no records in the range', () => {
    const out = buildOutputFile(
      fixtureOutputFileInput({
        events: [],
        annotations: [],
        certifications: [],
        malfunctions: [],
        loginLogout: [],
        enginePower: [],
        unidentified: [],
      }),
    );
    const result = validateOutputFile(out.csv);
    expect(result.issues).toEqual([]);
    expect(result.counts.events).toBe(0);
  });

  it('handles a co-driver header line', () => {
    const out = buildOutputFile(
      fixtureOutputFileInput({ coDriver: { lastName: 'Lee', firstName: 'Ann', username: 'alee' } }),
    );
    expect(out.csv.split('\r\n')[2].startsWith('Lee,Ann,alee,')).toBe(true);
    expect(validateOutputFile(out.csv).valid).toBe(true);
  });

  it('marks an exempt driver with E in header line 5', () => {
    const base = fixtureOutputFileInput();
    const out = buildOutputFile({ ...base, driver: { ...base.driver, exempt: true } });
    expect(segment('header', out.csv)[4].split(',')[1]).toBe('E');
  });

  it('still produces a conformant file for a 65535 -> wrap sequence id', () => {
    const base = fixtureOutputFileInput();
    const out = buildOutputFile({ ...base, events: [fixtureEvent({ sequenceId: 65535 }), fixtureEvent({ sequenceId: 65536 })] });
    expect(validateOutputFile(out.csv).valid).toBe(true);
  });
});
