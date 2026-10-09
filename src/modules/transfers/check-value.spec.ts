import {
  charValue,
  eventDataCheckValue,
  fileDataCheckValue,
  formatCheckValue,
  lineCheckValue,
  mappedSum,
  renderDataLine,
  rotateLeft3,
  splitDataLine,
  verifyDataLine,
} from './check-value';

describe('Appendix A 4.4.5 — data check values', () => {
  it('maps characters per Table 3: 1-9 -> 1-9, A-Z -> 17-42, a-z -> 49-74, everything else -> 0', () => {
    expect(['0', '1', '9', 'A', 'Z', 'a', 'z'].map(charValue)).toEqual([0, 1, 9, 17, 42, 49, 74]);
    expect([',', '.', '-', ' ', ';', '_'].map(charValue)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(mappedSum('SMITH')).toBe(35 + 29 + 25 + 36 + 24);
  });

  it('rotates an 8-bit value left three times with carry-around', () => {
    expect(rotateLeft3(0x11)).toBe(0x88);
    expect(rotateLeft3(0x20)).toBe(0x01);
    expect(rotateLeft3(0xbc)).toBe(0xe5);
    expect(rotateLeft3(0xff)).toBe(0xff);
  });

  it('renders 2 uppercase hex digits', () => {
    expect(formatCheckValue(0)).toBe('00');
    expect(formatCheckValue(15)).toBe('0F');
    expect(formatCheckValue(255)).toBe('FF');
  });

  it('computes the line data check value: low byte, rotl3, XOR 0x96 (4.4.5.2)', () => {
    // Empty line: 0 -> 0 -> 0x96.
    expect(lineCheckValue('')).toBe('96');
    // 'A' = 17 = 0x11 -> 0x88 -> ^0x96 = 0x1E.
    expect(lineCheckValue('A')).toBe('1E');
    // SMITH (149) + JOHN (111) = 260 -> 0x04 -> 0x20 -> ^0x96 = 0xB6. Commas count 0.
    expect(lineCheckValue('SMITH,JOHN')).toBe('B6');
    expect(lineCheckValue('SMITHJOHN')).toBe('B6');
  });

  it('computes the event data check value: 10 elements, low byte, rotl3, XOR 0xC3 (4.4.5.1)', () => {
    expect(eventDataCheckValue([])).toBe('C3');
    // type 1, code 1, 090426, 060000, 45, 1.5, 41.32, -72.93, 101, jsmith -> 444 -> 0xBC -> 0xE5 -> ^0xC3 = 0x26.
    expect(eventDataCheckValue(['1', '1', '090426', '060000', '45', '1.5', '41.32', '-72.93', '101', 'jsmith'])).toBe('26');
  });

  it('computes the 16-bit file data check value: rotl3 per byte, XOR 0x969C (4.4.5.3)', () => {
    expect(fileDataCheckValue([])).toBe('969C');
    // 0x0001 -> 0x00,0x08 -> ^0x969C = 0x9694.
    expect(fileDataCheckValue(['01'])).toBe('9694');
    // 0xFF + 0xFF = 0x01FE -> 0x08,0xF7 -> ^0x969C = 0x9E6B.
    expect(fileDataCheckValue(['FF', 'FF'])).toBe('9E6B');
    expect(fileDataCheckValue(['FF', 'FF'])).toMatch(/^[0-9A-F]{4}$/);
  });

  it('appends the check value to a data line and verifies it', () => {
    const line = renderDataLine(['SMITH', 'JOHN']);
    expect(line).toBe('SMITH,JOHN,B6');
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
});
