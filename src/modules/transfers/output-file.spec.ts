import { verifyDataLine } from './check-value';
import { fixtureEvent, fixtureOutputFileInput } from './output-file.fixture';
import {
  buildOutputFile,
  csvField,
  formatCoordinate,
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

  it('formats the header time-zone offset as whole hours to subtract from UTC', () => {
    expect(formatTimeZoneOffset(-240)).toBe('4');
    expect(formatTimeZoneOffset(-300)).toBe('5');
    expect(formatTimeZoneOffset(-480)).toBe('8');
  });

  it('renders the event sequence id as 4 hex digits and wraps FFFF -> 0001', () => {
    expect(formatSequenceId(1)).toBe('0001');
    expect(formatSequenceId(255)).toBe('00FF');
    expect(formatSequenceId(65535)).toBe('FFFF');
    expect(formatSequenceId(65536)).toBe('0001');
  });

  it('uses 0.01 degree resolution normally and 0.1 degree for a 10-mile (PC) record', () => {
    expect(formatCoordinate(41.318511, 1)).toBe('41.32');
    expect(formatCoordinate(-72.928932, 1)).toBe('-72.93');
    expect(formatCoordinate(41.318511, 10)).toBe('41.3');
    expect(formatCoordinate(null, 1)).toBe('');
  });

  it('writes the Appendix A 4.6.1.4 position markers: E (malfunction) > fix > M (manual) > X', () => {
    expect(formatEventPosition(fixtureEvent())).toEqual(['41.32', '-72.93']);
    expect(formatEventPosition(fixtureEvent({ locationPrecisionMi: 10 }))).toEqual(['41.3', '-72.9']);
    const noFix = { latitude: null, longitude: null };
    expect(formatEventPosition(fixtureEvent({ ...noFix, locationDescription: 'Pilot Truck Stop, Exit 12' }))).toEqual(['M', 'M']);
    expect(formatEventPosition(fixtureEvent(noFix))).toEqual(['X', 'X']);
    expect(formatEventPosition(fixtureEvent({ ...noFix, locationDescription: '   ' }))).toEqual(['X', 'X']);
    // Half a position is no position.
    expect(formatEventPosition(fixtureEvent({ longitude: null }))).toEqual(['X', 'X']);
    // 4.6.1.4(c): E wins even when the driver typed a location.
    expect(
      formatEventPosition(fixtureEvent({ ...noFix, locationDescription: 'Yard', positioningMalfunction: true })),
    ).toEqual(['E', 'E']);
    expect(formatEventPosition(fixtureEvent({ positioningMalfunction: true }))).toEqual(['E', 'E']);
    // Login/logout (eventType 5) carries no location: never a marker.
    expect(formatEventPosition(fixtureEvent({ ...noFix, eventType: 5, eventCode: 1 }))).toEqual(['', '']);
  });

  it('leaves unknown miles / engine hours empty instead of inventing a zero', () => {
    expect(formatMiles(null)).toBe('');
    expect(formatMiles(120_345.9)).toBe('120345');
    expect(formatEngineHours(null)).toBe('');
    expect(formatEngineHours(4321.44)).toBe('4321.4');
  });

  it('strips commas, newlines and non-ASCII from a text field (Appendix A has no quoting)', () => {
    expect(csvField('Smith, John\r\nJr')).toBe('Smith John Jr');
    expect(csvField('Ödön')).toBe('dn');
    expect(csvField('a'.repeat(80), 60)).toHaveLength(60);
  });
});

describe('Appendix A output file generator', () => {
  const file = buildOutputFile(fixtureOutputFileInput());
  const lines = file.csv.split('\r\n').filter((l) => l !== '');

  it('emits the nine segments in the tz.md §10.2 / Appendix A order', () => {
    const titles = lines.filter((l) => Object.values(SEGMENT_TITLES).includes(l as never));
    expect(titles).toEqual(SEGMENT_ORDER.map((k) => SEGMENT_TITLES[k]));
  });

  it('ends with the file data check value and a CRLF', () => {
    expect(file.csv.endsWith('\r\n')).toBe(true);
    expect(lines.at(-2)).toBe(SEGMENT_TITLES.endOfFile);
    expect(lines.at(-1)).toMatch(/^[0-9A-F]{2}$/);
    expect(lines.at(-1)).toBe(file.fileCheckValue);
  });

  it('puts a valid line data check value on every data line', () => {
    const dataLines = lines.filter(
      (l) => !Object.values(SEGMENT_TITLES).includes(l as never) && l !== file.fileCheckValue,
    );
    expect(dataLines.length).toBeGreaterThan(10);
    for (const line of dataLines) expect(verifyDataLine(line)).toBe(true);
  });

  it('writes the 4-character ELD identifier and registration id, never a 6-character one', () => {
    const header = lines.slice(1, 10);
    const idLine = header[7];
    const [registrationId, identifier] = idLine.split(',');
    expect(identifier).toBe('OBK1');
    expect(identifier).toHaveLength(4);
    expect(registrationId).toBe('OBK1');
  });

  it('REFUSES a 6-character ELD identifier instead of truncating it into a wrong one', () => {
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldIdentifier: 'TEST01' }))).toThrow(/exactly 4 characters/);
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldIdentifier: 'OBK' }))).toThrow(RangeError);
    expect(() => buildOutputFile(fixtureOutputFileInput({ eldIdentifier: 'ob-1' }))).toThrow(RangeError);
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
    const commentLine = out.csv.split('\r\n')[9];
    expect(commentLine.split(',')[0]).toHaveLength(60);
  });

  it('caps an annotation at the Appendix A 60-character limit', () => {
    const annotationSegment = file.csv
      .split(SEGMENT_TITLES.annotations + '\r\n')[1]
      .split(SEGMENT_TITLES.certifications)[0]
      .split('\r\n')
      .filter(Boolean);
    expect(annotationSegment).toHaveLength(2);
    expect(annotationSegment[1].split(',')[2]).toHaveLength(60);
  });

  it('exports a manually located record as M,M plus its Driver\'s Location Description (4.3.2.7)', () => {
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
          userOrderNumber: 1,
          text: '',
          dateTime: manual.dateTime,
          timezoneOffsetMin: manual.timezoneOffsetMin,
          locationDescription: 'Pilot, Exit 12, Hartford CT',
        },
      ],
    });
    const seg = (title: string, next: string) =>
      out.csv.split(title + '\r\n')[1].split(next)[0].split('\r\n').filter(Boolean);
    const [eventLine] = seg(SEGMENT_TITLES.events, SEGMENT_TITLES.annotations);
    expect(eventLine.split(',').slice(9, 12)).toEqual(['M', 'M', '3']);
    expect(verifyDataLine(eventLine)).toBe(true);
    const [annotationLine] = seg(SEGMENT_TITLES.annotations, SEGMENT_TITLES.certifications);
    // Commas are stripped (Appendix A has no quoting); the description is the 6th field.
    expect(annotationLine.split(',')[5]).toBe('Pilot Exit 12 Hartford CT');
    expect(verifyDataLine(annotationLine)).toBe(true);
    expect(validateOutputFile(out.csv).issues).toEqual([]);
  });

  it('writes X,X for a located record with no position and no typed location', () => {
    const eventSegment = file.csv
      .split(SEGMENT_TITLES.events + '\r\n')[1]
      .split(SEGMENT_TITLES.annotations)[0]
      .split('\r\n')
      .filter(Boolean);
    const intermediate = eventSegment.find((l) => l.startsWith('0007,'));
    expect(intermediate?.split(',').slice(9, 11)).toEqual(['X', 'X']);
  });

  it('keeps superseded (recordStatus 2) and edited (recordOrigin 2) records in the event list', () => {
    const eventSegment = file.csv
      .split(SEGMENT_TITLES.events + '\r\n')[1]
      .split(SEGMENT_TITLES.annotations)[0]
      .split('\r\n')
      .filter(Boolean);
    expect(eventSegment).toHaveLength(8);
    expect(eventSegment.some((l) => l.split(',')[1] === '2')).toBe(true);
    expect(eventSegment.some((l) => l.split(',')[2] === '2')).toBe(true);
  });

  it('lists unidentified driving records with recordOrigin 4 in their own segment', () => {
    const segment = file.csv
      .split(SEGMENT_TITLES.unidentified + '\r\n')[1]
      .split(SEGMENT_TITLES.endOfFile)[0]
      .split('\r\n')
      .filter(Boolean);
    expect(segment).toHaveLength(1);
    expect(segment[0].split(',')[2]).toBe('4');
  });

  it('is byte-for-byte stable across regenerations (event sequence ids come from ingest)', () => {
    const again = buildOutputFile(fixtureOutputFileInput());
    expect(again.csv).toBe(file.csv);
    expect(again.fileCheckValue).toBe(file.fileCheckValue);
  });

  it('generates an empty-but-valid file when a driver has no records in the range', () => {
    const out = buildOutputFile(
      fixtureOutputFileInput({ events: [], annotations: [], certifications: [], malfunctions: [], unidentified: [] }),
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

  it('marks an exempt driver with E in the header', () => {
    const base = fixtureOutputFileInput();
    const out = buildOutputFile({ ...base, driver: { ...base.driver, exempt: true } });
    expect(out.csv.split('\r\n')[6].startsWith('E,')).toBe(true);
  });

  it('still produces a conformant file for a 65535 -> wrap sequence id', () => {
    const base = fixtureOutputFileInput();
    const out = buildOutputFile({ ...base, events: [fixtureEvent({ sequenceId: 65535 })] });
    expect(validateOutputFile(out.csv).valid).toBe(true);
  });
});
