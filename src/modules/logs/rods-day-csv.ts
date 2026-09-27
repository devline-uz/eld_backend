import type { EldEvent } from '@prisma/client';
import { wallClock } from '../hos/engine/timezone';

/**
 * mobile/tz.md §21 MB-18 / screen P-05 `Download` — one RODS day as a flat CSV.
 *
 * Same per-day record list the §13.5 inspection packet shows (every §395 record of the day,
 * superseded/proposed ones included, ordered by eventDateTime then eventSequenceId). This is a
 * human-readable day export, NOT the §395 Appendix A output file — that one is
 * `transfers/output-file.ts` and reaches an officer through `POST /mobile/transfers`.
 */
export const RODS_DAY_CSV_HEADERS = [
  'sequenceId',
  'eventType',
  'eventCode',
  'eventDateTime',
  'status',
  'location',
  'odometerMi',
  'engineHours',
  'origin',
  'recordStatus',
  'annotation',
] as const;

const STATUS_BY_CODE: Record<number, string> = { 1: 'OFF', 2: 'SB', 3: 'D', 4: 'ON' };
const ORIGIN_LABEL: Record<number, string> = { 1: 'ELD', 2: 'DRIVER', 3: 'CARRIER', 4: 'UNIDENTIFIED' };
const RECORD_STATUS_LABEL: Record<number, string> = { 1: 'ACTIVE', 2: 'INACTIVE_CHANGED', 3: 'INACTIVE_CHANGE_REQUESTED', 4: 'INACTIVE_CHANGE_REJECTED' };

/** Event type 3 (intermediate) rows carry the duty status in effect, but we only label type 1. */
export function dutyStatusLabel(event: Pick<EldEvent, 'eventType' | 'eventCode'>): string {
  if (event.eventType !== 1) return '';
  return STATUS_BY_CODE[event.eventCode] ?? '';
}

/** Home-terminal wall clock, `YYYY-MM-DD HH:mm:ss` (no offset — the whole file is one timezone). */
export function localDateTime(timezone: string, instant: Date): string {
  const w = wallClock(timezone, instant);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}:${p(w.second)}`;
}

/** RFC 4180 quoting: wrap when the value contains a comma, quote, CR or LF; double the quotes. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rodsDayRow(event: EldEvent, timezone: string): string[] {
  return [
    String(event.eventSequenceId),
    String(event.eventType),
    String(event.eventCode),
    localDateTime(timezone, event.eventDateTime),
    dutyStatusLabel(event),
    event.locationName ?? '',
    event.totalVehicleMiles === null ? '' : String(event.totalVehicleMiles),
    event.totalEngineHours === null ? '' : String(event.totalEngineHours),
    ORIGIN_LABEL[event.recordOrigin] ?? String(event.recordOrigin),
    RECORD_STATUS_LABEL[event.recordStatus] ?? String(event.recordStatus),
    event.annotation ?? '',
  ];
}

/** CRLF line endings, header row first, trailing newline; UTF-8 without BOM. */
export function buildRodsDayCsv(events: EldEvent[], timezone: string): string {
  const lines = [RODS_DAY_CSV_HEADERS.join(',')];
  for (const event of events) lines.push(rodsDayRow(event, timezone).map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** P-05 download name: `RODS_<date>.csv` — A-Z 0-9 `_` `-` `.` only. */
export function rodsDayFileName(date: string, format: 'csv' | 'pdf'): string {
  return `RODS_${date.replace(/[^0-9-]/g, '')}.${format}`;
}
