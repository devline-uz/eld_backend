/**
 * Appendix A 4.4.5.3 / 4.4.5.4 — line data check value and file data check value.
 *
 * Every data line of the eRODS output file ends with its own check value, and the file ends
 * with a single file data check value. Both are computed the same way:
 *
 *   line check value = (sum of the byte values of every character on the line, EXCLUDING the
 *                       check value field itself and the comma in front of it) mod 256
 *   file check value = (sum of every line check value in the file) mod 256
 *
 * Both are rendered as 2 uppercase hexadecimal digits so the value is printable ASCII and
 * survives an email round-trip. `Buffer.byteLength`-style UTF-8 bytes are summed, which for
 * a conformant file (Appendix A restricts the payload to printable ASCII) is identical to
 * summing ASCII codes.
 */

/** Sum of UTF-8 byte values of `payload`, mod 256. */
export function checkValueOf(payload: string): number {
  let sum = 0;
  for (const byte of Buffer.from(payload, 'utf8')) sum = (sum + byte) % 256;
  return sum;
}

/** 2 uppercase hex digits, e.g. `0F`, `A3`. */
export function formatCheckValue(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** Check value of one data line, given the line WITHOUT its trailing check-value field. */
export function lineCheckValue(lineWithoutCheckValue: string): string {
  return formatCheckValue(checkValueOf(lineWithoutCheckValue));
}

/** Appends the Appendix A check value to a list of already-rendered fields. */
export function renderDataLine(fields: readonly string[]): string {
  const payload = fields.join(',');
  return `${payload},${lineCheckValue(payload)}`;
}

/** Appendix A 4.4.5.4 — the file data check value over every line check value, in order. */
export function fileDataCheckValue(lineCheckValues: readonly string[]): string {
  let sum = 0;
  for (const cv of lineCheckValues) sum = (sum + parseInt(cv, 16)) % 256;
  return formatCheckValue(sum);
}

/** Splits a rendered data line back into `{ fields, checkValue }` for the validator. */
export function splitDataLine(line: string): { fields: string[]; checkValue: string } {
  const parts = line.split(',');
  const checkValue = parts[parts.length - 1] ?? '';
  return { fields: parts.slice(0, -1), checkValue };
}

/** True when a rendered data line carries the check value Appendix A requires. */
export function verifyDataLine(line: string): boolean {
  const idx = line.lastIndexOf(',');
  if (idx < 0) return false;
  return lineCheckValue(line.slice(0, idx)) === line.slice(idx + 1);
}
