/**
 * eRODS output file NAME — 49 CFR §395 Appendix A 4.8.2.2 (tz.md §10.2).
 *
 * The name is built from the DRIVER's data, never from the ELD identifier. The pre-v3.1
 * shape `{ELD_IDENTIFIER}_{LastName}_{YYYYMMDD}.csv` (`TEST01_Smith_20250910.csv`) and the
 * Figma label `ONEB01_Smith_20250910.csv` are both wrong and are superseded here — §395
 * wins over Figma (see decisions.md D-036).
 *
 *   [first 5 chars of last name][last 2 chars of CDL number][2-digit file sequence][1-digit day count].csv
 *
 *   John Smith · CDL W8569238 · 8-day range · first file of the day
 *     -> "SMITH" + "38" + "01" + "8" + ".csv" = SMITH38018.csv
 *
 * Rules:
 *  - `A-Z` and `0-9` only; every other character (space, `-`, `'`, `.`) is DROPPED, not replaced.
 *  - Everything uppercase.
 *  - A last name shorter than 5 characters is NOT padded.
 *  - The file sequence is how many files this driver already got today (from `DataTransfer`) + 1.
 *  - Day count is the number of days in the requested range — normally 8, and never more
 *    (a wider range is rejected with `RANGE_TOO_LARGE` before we get here).
 *
 * This module is deliberately pure: no Prisma, no Nest, no clock.
 */

export interface OutputFileNameInput {
  /** Driver's last name, raw (apostrophes / spaces / hyphens allowed). */
  lastName: string;
  /** Driver's CDL (driver's license) number, raw. */
  cdlNumber: string;
  /** 1-based index of this file for this driver on this calendar day. */
  sequence: number;
  /** Number of days covered by the file (inclusive). 1..9; 8 is the normal case. */
  dayCount: number;
}

/** Appendix A 4.8.2.2 character set: keep `[A-Z0-9]`, drop everything else, uppercase. */
export function sanitizeNameToken(value: string): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** `01`, `02`, … Sequences are 2 digits; 100 wraps back to `00` (Appendix A has no 3rd digit). */
export function formatFileSequence(sequence: number): string {
  const n = Math.trunc(sequence);
  if (!Number.isFinite(n) || n < 1) throw new RangeError(`file sequence must be >= 1, got ${sequence}`);
  return String(n % 100).padStart(2, '0');
}

/** Day count is a SINGLE digit in the file name; the range validator caps the range at 8 days. */
export function formatDayCount(dayCount: number): string {
  const n = Math.trunc(dayCount);
  if (!Number.isFinite(n) || n < 1 || n > 9) {
    throw new RangeError(`day count must be 1..9 to fit Appendix A 4.8.2.2, got ${dayCount}`);
  }
  return String(n);
}

/** Builds the Appendix A 4.8.2.2 file name. Pure — unit-tested in `filename.spec.ts`. */
export function buildOutputFileName(input: OutputFileNameInput): string {
  const last = sanitizeNameToken(input.lastName).slice(0, 5);
  const cdl = sanitizeNameToken(input.cdlNumber);
  // "last 2 characters of the license number"; a 1-character licence contributes 1 character
  // and a missing one contributes nothing — short values are never padded (4.8.2.2).
  const cdlTail = cdl.slice(-2);
  return `${last}${cdlTail}${formatFileSequence(input.sequence)}${formatDayCount(input.dayCount)}.csv`;
}

/** Inclusive day count of a RODS range, used for the file name's last digit. */
export function inclusiveDayCount(rangeStart: Date, rangeEnd: Date): number {
  const MS_PER_DAY = 86_400_000;
  const start = Date.UTC(rangeStart.getUTCFullYear(), rangeStart.getUTCMonth(), rangeStart.getUTCDate());
  const end = Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate());
  return Math.floor((end - start) / MS_PER_DAY) + 1;
}
