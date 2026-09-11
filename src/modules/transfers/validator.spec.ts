import { fileDataCheckValue, renderDataLine } from './check-value';
import { buildOutputFile } from './output-file';
import { fixtureOutputFileInput } from './output-file.fixture';
import { SEGMENT_TITLES } from './segments';
import { parseOutputFile, validateOutputFile } from './validator';

const good = buildOutputFile(fixtureOutputFileInput()).csv;

/** Re-computes the trailing file data check value so a mutation stays otherwise conformant. */
function rechecksum(csv: string): string {
  const lines = csv.split('\r\n');
  const endIdx = lines.indexOf(SEGMENT_TITLES.endOfFile);
  const titles = new Set<string>(Object.values(SEGMENT_TITLES));
  const checkValues = lines
    .slice(0, endIdx)
    .filter((l) => l !== '' && !titles.has(l))
    .map((l) => l.slice(l.lastIndexOf(',') + 1));
  lines[endIdx + 1] = fileDataCheckValue(checkValues);
  return lines.join('\r\n');
}

describe('Appendix A output file validator', () => {
  it('accepts a file produced by the generator', () => {
    const result = validateOutputFile(good);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.fileCheckValue).toMatch(/^[0-9A-F]{2}$/);
  });

  it('reports the data-line count of every segment', () => {
    const { counts } = validateOutputFile(good);
    expect(counts).toMatchObject({
      header: 9,
      users: 2,
      cmvs: 1,
      malfunctions: 2,
      events: 8,
      annotations: 2,
      certifications: 2,
      unidentified: 1,
      endOfFile: 1,
    });
  });

  it('catches a tampered data line through its line check value', () => {
    const tampered = rechecksum(good.replace('OneBook Logistics LLC', 'Someone Else LLC'));
    const result = validateOutputFile(tampered);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('LINE_CHECK_VALUE');
  });

  it('catches a wrong file data check value', () => {
    const lines = good.split('\r\n');
    const endIdx = lines.indexOf(SEGMENT_TITLES.endOfFile);
    lines[endIdx + 1] = lines[endIdx + 1] === 'FF' ? '00' : 'FF';
    const result = validateOutputFile(lines.join('\r\n'));
    expect(result.issues.map((i) => i.code)).toContain('FILE_CHECK_VALUE');
  });

  it('catches a missing segment', () => {
    const result = validateOutputFile(good.replace(SEGMENT_TITLES.cmvs + '\r\n', ''));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('MISSING_SEGMENT');
  });

  it('catches segments emitted out of Appendix A order', () => {
    // Swap the User list and the CMV list titles.
    const swapped = good
      .replace(SEGMENT_TITLES.users, '@@TMP@@')
      .replace(SEGMENT_TITLES.cmvs, SEGMENT_TITLES.users)
      .replace('@@TMP@@', SEGMENT_TITLES.cmvs);
    const result = validateOutputFile(swapped);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('SEGMENT_ORDER');
  });

  it('catches a 6-character ELD identifier smuggled into the header', () => {
    const lines = good.split('\r\n');
    lines[8] = renderDataLine(['OBK1', 'TEST01', 'A1B2C3D4']);
    const result = validateOutputFile(rechecksum(lines.join('\r\n')));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('ELD_IDENTIFIER_LENGTH');
  });

  it('catches a header line with the wrong number of fields', () => {
    const lines = good.split('\r\n');
    lines[1] = renderDataLine(['Smith', 'John']);
    const result = validateOutputFile(rechecksum(lines.join('\r\n')));
    expect(result.issues.map((i) => i.code)).toContain('HEADER_FIELD_COUNT');
  });

  it('catches a missing driver last name or license number (they feed the file name)', () => {
    const lines = good.split('\r\n');
    lines[1] = renderDataLine(['', 'John', 'jsmith', 'CT', '']);
    const codes = validateOutputFile(rechecksum(lines.join('\r\n'))).issues.map((i) => i.code);
    expect(codes).toContain('DRIVER_LAST_NAME_MISSING');
    expect(codes).toContain('DRIVER_LICENSE_MISSING');
  });

  it('catches an event list line with the wrong field count', () => {
    const broken = good.replace(
      SEGMENT_TITLES.events + '\r\n',
      SEGMENT_TITLES.events + '\r\n' + renderDataLine(['0001', '1', '1']) + '\r\n',
    );
    const codes = validateOutputFile(rechecksum(broken)).issues.map((i) => i.code);
    expect(codes).toContain('FIELD_COUNT');
  });

  it('catches a non-hex event sequence id and an out-of-range record status', () => {
    const badLine = renderDataLine([
      '1', '9', '1', '1', '3', '090426', '090000', '100', '10.0', '41.32', '-72.93', '0', '1', '1', '0', '0',
    ]);
    const broken = good.replace(SEGMENT_TITLES.events + '\r\n', SEGMENT_TITLES.events + '\r\n' + badLine + '\r\n');
    const codes = validateOutputFile(rechecksum(broken)).issues.map((i) => i.code);
    expect(codes).toContain('EVENT_SEQUENCE_ID_FORMAT');
    expect(codes).toContain('EVENT_FIELD_RANGE');
  });

  it('catches a malformed event date / time', () => {
    const badLine = renderDataLine([
      '0001', '1', '1', '1', '3', '2026-09-04', '25:00', '100', '10.0', '41.32', '-72.93', '0', '1', '1', '0', '0',
    ]);
    const broken = good.replace(SEGMENT_TITLES.events + '\r\n', SEGMENT_TITLES.events + '\r\n' + badLine + '\r\n');
    const codes = validateOutputFile(rechecksum(broken)).issues.map((i) => i.code);
    expect(codes).toContain('EVENT_DATE_FORMAT');
    expect(codes).toContain('EVENT_TIME_FORMAT');
  });

  it('catches an over-long output file comment in the header', () => {
    const lines = good.split('\r\n');
    lines[9] = renderDataLine(['C'.repeat(61)]);
    const codes = validateOutputFile(rechecksum(lines.join('\r\n'))).issues.map((i) => i.code);
    expect(codes).toContain('OUTPUT_FILE_COMMENT_TOO_LONG');
  });

  it('catches a missing final CRLF', () => {
    const codes = validateOutputFile(good.trimEnd()).issues.map((i) => i.code);
    expect(codes).toContain('MISSING_FINAL_TERMINATOR');
  });

  it('catches a missing file data check value line', () => {
    const codes = validateOutputFile(good.replace(/[0-9A-F]{2}\r\n$/, '')).issues.map((i) => i.code);
    expect(codes).toContain('FILE_CHECK_VALUE_MISSING');
  });

  it('reports the physical line number of a line-local problem', () => {
    const lines = good.split('\r\n');
    lines[5] = lines[5] + 'X';
    const issue = validateOutputFile(lines.join('\r\n')).issues.find((i) => i.code === 'LINE_CHECK_VALUE');
    expect(issue?.line).toBe(6);
  });

  describe('parseOutputFile', () => {
    it('groups data lines under their segment title', () => {
      const segments = parseOutputFile(good);
      expect(segments.map((s) => s.key)).toEqual([
        'header',
        'users',
        'cmvs',
        'malfunctions',
        'events',
        'annotations',
        'certifications',
        'unidentified',
        'endOfFile',
      ]);
      expect(segments[0].titleLine).toBe(1);
    });
  });
});
