/**
 * eRODS output file NAME — 49 CFR §395 Subpart B Appendix A 4.8.2.2 (official text in
 * `docs/fmcsa/49cfr395-subpartB-appendixA.txt`). 25 characters + `.csv`:
 *
 *   pos  1-5   first five letters of the driver's last name, `_`-padded when shorter   (a)
 *   pos  6-7   last two digits of the driver's license number                          (b)
 *   pos  8-9   sum of all numeric digits of the license number, last 2 digits, 0-padded (c)
 *   pos 10-15  file creation date MMDDYY                                               (d)
 *   pos 16     `-`                                                                     (e)
 *   pos 17-25  nine carrier/provider-configurable [0-9A-Z] chars, default `000000000`  (f)
 *
 *   John Smith · licence W8569238 · created 2026-09-11 · first file of the day
 *     -> "SMITH" + "38" + "41" + "091126" + "-" + "000000000" = SMITH3841091126-000000000.csv
 *
 * This REPLACES the earlier `[last5][cdl2][seq2][days1].csv` shape (`SMITH38018.csv`) that
 * tz.md §10.2 and the agent contract describe: §395 wins over both (bugs.md B-136, D-024).
 *
 * OneBook choices inside the standard (decisions.md D-120):
 *  - (a) letters only (`O'Brien` -> `OBRIE`, `Ng` -> `NG___`), uppercased.
 *  - (b) fewer than two digits in the licence -> left-padded with `0` (`7` -> `07`), mirroring (c).
 *  - (d) the creation date in the driver's home-terminal time.
 *  - (f) the per-driver, per-day file sequence from `DataTransfer`, minus one, as 9 decimal
 *        digits: the first file of the day keeps the default `000000000`, the second gets
 *        `000000001`, so two files of one day never share a name.
 */

export interface OutputFileNameInput {
  /** Driver's last name, raw (apostrophes / spaces / hyphens allowed). */
  lastName: string;
  /** Driver's license number, raw. */
  cdlNumber: string;
  /** 1-based index of this file for this driver on this calendar day (from `DataTransfer`). */
  sequence: number;
  /** File creation instant (4.8.2.2(d)) — the same instant as the header's Current Date/Time. */
  createdAt: Date;
  /** Signed minutes to add to UTC for the home terminal (EDT = -240). Default 0. */
  timezoneOffsetMin?: number;
}

/** 4.8.2.2(a) — first five LETTERS of the last name, uppercased, `_`-padded to 5. */
export function lastNameToken(lastName: string): string {
  return (lastName ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5).padEnd(5, '_');
}

/** Digits of the licence number only (7.11 keeps [0-9A-Z]; 4.8.2.2(b)/(c) look at digits). */
function licenseDigits(cdlNumber: string): string {
  return (cdlNumber ?? '').replace(/[^0-9]/g, '');
}

/** 4.8.2.2(b) — last two digits of the licence number; fewer than two -> `0`-padded. */
export function licenseLastTwoDigits(cdlNumber: string): string {
  return licenseDigits(cdlNumber).slice(-2).padStart(2, '0');
}

/** 4.8.2.2(c) — sum of the licence number's digits, last two digits, `0`-padded. */
export function licenseDigitSum(cdlNumber: string): string {
  const sum = [...licenseDigits(cdlNumber)].reduce((acc, d) => acc + Number(d), 0);
  return String(sum % 100).padStart(2, '0');
}

/** 4.8.2.2(d) — MMDDYY of the creation date in home-terminal time. */
export function formatFileDate(createdAt: Date, timezoneOffsetMin = 0): string {
  const d = new Date(createdAt.getTime() + timezoneOffsetMin * 60_000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${mm}${dd}${yy}`;
}

/** 4.8.2.2(f) — 9 configurable characters; OneBook uses `sequence - 1` as 9 digits. */
export function formatFileSuffix(sequence: number): string {
  const n = Math.trunc(sequence);
  if (!Number.isFinite(n) || n < 1 || n > 1_000_000_000) {
    throw new RangeError(`file sequence must be 1..1000000000, got ${sequence}`);
  }
  return String(n - 1).padStart(9, '0');
}

/** Builds the Appendix A 4.8.2.2 file name. Unit-tested in `filename.spec.ts`. */
export function buildOutputFileName(input: OutputFileNameInput): string {
  const createdAt = input.createdAt;
  return (
    lastNameToken(input.lastName) +
    licenseLastTwoDigits(input.cdlNumber) +
    licenseDigitSum(input.cdlNumber) +
    formatFileDate(createdAt, input.timezoneOffsetMin ?? 0) +
    '-' +
    formatFileSuffix(input.sequence) +
    '.csv'
  );
}

/** Inclusive day count of a RODS range (pre-send RANGE_TOO_LARGE check, tz.md §10.3). */
export function inclusiveDayCount(rangeStart: Date, rangeEnd: Date): number {
  const MS_PER_DAY = 86_400_000;
  const start = Date.UTC(rangeStart.getUTCFullYear(), rangeStart.getUTCMonth(), rangeStart.getUTCDate());
  const end = Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate());
  return Math.floor((end - start) / MS_PER_DAY) + 1;
}
