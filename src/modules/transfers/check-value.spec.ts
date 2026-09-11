import {
  checkValueOf,
  fileDataCheckValue,
  formatCheckValue,
  lineCheckValue,
  renderDataLine,
  splitDataLine,
  verifyDataLine,
} from './check-value';

describe('Appendix A 4.4.5.3/4.4.5.4 — check values', () => {
  it('sums byte values modulo 256', () => {
    expect(checkValueOf('A')).toBe(65);
    expect(checkValueOf('AB')).toBe(131);
    // 256 'A' bytes (65 * 256) wrap back to 0.
    expect(checkValueOf('A'.repeat(256))).toBe(0);
  });

  it('renders 2 uppercase hex digits', () => {
    expect(formatCheckValue(0)).toBe('00');
    expect(formatCheckValue(15)).toBe('0F');
    expect(formatCheckValue(255)).toBe('FF');
    expect(lineCheckValue('A')).toBe('41');
  });

  it('appends the check value to a data line and verifies it', () => {
    const line = renderDataLine(['SMITH', 'JOHN']);
    expect(line).toBe(`SMITH,JOHN,${lineCheckValue('SMITH,JOHN')}`);
    expect(verifyDataLine(line)).toBe(true);
  });

  it('detects a tampered data line', () => {
    const line = renderDataLine(['0001', '1', '1', '1', '3']);
    const tampered = line.replace('3,', '4,');
    expect(verifyDataLine(tampered)).toBe(false);
  });

  it('rejects a line with no check-value field at all', () => {
    expect(verifyDataLine('NOCOMMAS')).toBe(false);
  });

  it('splits a data line back into fields and check value', () => {
    expect(splitDataLine('A,B,41')).toEqual({ fields: ['A', 'B'], checkValue: '41' });
  });

  it('folds line check values into the file data check value', () => {
    expect(fileDataCheckValue(['01', '02', '03'])).toBe('06');
    expect(fileDataCheckValue(['FF', '02'])).toBe('01');
    expect(fileDataCheckValue([])).toBe('00');
  });
});
