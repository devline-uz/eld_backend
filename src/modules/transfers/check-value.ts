/**
 * Appendix A 4.4.5 — Event / Line / File data check values.
 *
 * Character mapping (4.4.5(b), Table 3): `1`..`9` -> 1..9, `A`..`Z` -> 17..42,
 * `a`..`z` -> 49..74 (i.e. ASCII code minus 48 for alphanumerics); every other character,
 * including `0`, `,`, `.`, `-` and space, counts as 0. NOTE: Table 3 itself is not in the
 * flattened text `docs/fmcsa/49cfr395-subpartB-appendixA.txt` (its tables were dropped); the
 * mapping above is the eCFR Table 3 and must be re-checked if that file gains the tables.
 *
 *   event data check (4.4.5.1): checksum = (sum of mapped chars of Event Type, Event Code,
 *       Event Date, Event Time, Vehicle Miles, Engine Hours, Event Latitude, Event Longitude,
 *       CMV Power Unit Number, ELD username) & 0xFF; rotate-left 3 (8-bit); XOR 0xC3 -> 2 hex.
 *   line data check (4.4.5.2): checksum = (sum of mapped chars of the whole line, excluding
 *       the line check value itself) & 0xFF; rotate-left 3 (8-bit); XOR 0x96 -> 2 hex.
 *   file data check (4.4.5.3): checksum = (sum of all line data check values) & 0xFFFF;
 *       rotate-left 3 on EACH 8-bit byte; XOR 0x969C -> 4 hex.
 *
 * All values are uppercase hexadecimal (7.21, 7.27, 7.32 examples: `CA`, `F0B5`, `A4`).
 */

/** Appendix A Table 3 value of one character. */
export function charValue(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x31 && c <= 0x39) return c - 48; // '1'..'9'
  if (c >= 0x41 && c <= 0x5a) return c - 48; // 'A'..'Z' -> 17..42
  if (c >= 0x61 && c <= 0x7a) return c - 48; // 'a'..'z' -> 49..74
  return 0;
}

/** Sum of Table 3 values of every character of `text` (no masking). */
export function mappedSum(text: string): number {
  let sum = 0;
  for (const ch of text) sum += charValue(ch);
  return sum;
}

/** Three consecutive 8-bit circular left shifts (4.4.5.1.2(a), 4.4.5.2.2(a), 4.4.5.3.2(a)(1)). */
export function rotateLeft3(byte: number): number {
  const b = byte & 0xff;
  return ((b << 3) | (b >>> 5)) & 0xff;
}

/** 2 uppercase hex digits, e.g. `0F`, `A3`. */
export function formatCheckValue(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** Appendix A 4.4.5.1 — Event Data Check Value over the 10 listed elements, as rendered. */
export function eventDataCheckValue(elements: readonly string[]): string {
  const checksum = mappedSum(elements.join('')) & 0xff;
  return formatCheckValue(rotateLeft3(checksum) ^ 0xc3);
}

/** Appendix A 4.4.5.2 — Line Data Check Value of a line WITHOUT its trailing check-value field. */
export function lineCheckValue(lineWithoutCheckValue: string): string {
  const checksum = mappedSum(lineWithoutCheckValue) & 0xff;
  return formatCheckValue(rotateLeft3(checksum) ^ 0x96);
}

/** Appends the Appendix A Line Data Check Value to already-rendered fields (4.4.5.2.3). */
export function renderDataLine(fields: readonly string[]): string {
  const payload = fields.join(',');
  return `${payload},${lineCheckValue(payload)}`;
}

/** Appendix A 4.4.5.3 — 16-bit File Data Check Value over every line data check value. */
export function fileDataCheckValue(lineCheckValues: readonly string[]): string {
  let sum = 0;
  for (const cv of lineCheckValues) sum += parseInt(cv, 16) || 0;
  const checksum = sum & 0xffff;
  const rotated = (rotateLeft3(checksum >>> 8) << 8) | rotateLeft3(checksum & 0xff);
  return ((rotated ^ 0x969c) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

/** Splits a rendered data line back into `{ fields, checkValue }` for the validator. */
export function splitDataLine(line: string): { fields: string[]; checkValue: string } {
  const parts = line.split(',');
  const checkValue = parts[parts.length - 1] ?? '';
  return { fields: parts.slice(0, -1), checkValue };
}

/** True when a rendered data line carries the Line Data Check Value Appendix A requires. */
export function verifyDataLine(line: string): boolean {
  const idx = line.lastIndexOf(',');
  if (idx < 0) return false;
  return lineCheckValue(line.slice(0, idx)) === line.slice(idx + 1);
}
