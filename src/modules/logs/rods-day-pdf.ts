import type { RodsDay } from './rods';
import type { AnnotatedSegment } from './day-extras';
import { wallClock } from '../hos/engine/timezone';

/**
 * MB-4 — view model of the `rods-day` PDF template (49 CFR §395.8(g) paper-form equivalent):
 * header fields, the 24-hour graph grid (OFF / SB / D / ON rows) and the remarks list.
 * Pure — numbers and strings only, because the template engine escapes every value (the graph
 * is therefore drawn with absolutely-positioned boxes, not injected SVG markup).
 */
export const GRAPH_ROW_HEIGHT_PX = 30;
const LINE_PX = 4;
/** §395.8: row order top to bottom is Off duty, Sleeper berth, Driving, On duty (not driving). */
const ROW_OF: Record<string, number> = { OFF: 0, SB: 1, D: 2, ON: 3 };
const ROW_LABEL = ['1. Off Duty', '2. Sleeper Berth', '3. Driving', '4. On Duty (not driving)'];

export interface RodsDayPdfInput {
  day: RodsDay;
  segments: AnnotatedSegment[];
  driver: { firstName: string; lastName: string; cdlNumber: string; cdlState: string; homeTerminalName: string };
  carrier: { name: string; dotNumber: string; address: string } | null;
  vehicles: { unitNumber: string; vin: string }[];
  trailerNumbers: string[];
  shippingDocuments: string[];
  certified: boolean;
  certifiedAt: Date | null;
  generatedAt: Date;
}

export function hm(sec: number): string {
  const total = Math.max(0, Math.round(sec / 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function pct(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

function clock(timezone: string, at: Date): string {
  const w = wallClock(timezone, at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(w.hour)}:${p(w.minute)}`;
}

export function buildRodsDayPdfData(input: RodsDayPdfInput): Record<string, unknown> {
  const { day, segments, driver, carrier } = input;
  const startMs = day.startAt.getTime();
  const span = Math.max(1, day.endAt.getTime() - startMs);
  const x = (at: Date): number => Math.min(100, Math.max(0, ((at.getTime() - startMs) / span) * 100));
  const rowMid = (row: number): number => row * GRAPH_ROW_HEIGHT_PX + GRAPH_ROW_HEIGHT_PX / 2;

  const lines: { left: string; width: string; top: number }[] = [];
  const links: { left: string; top: number; height: number }[] = [];
  segments.forEach((seg, i) => {
    const row = ROW_OF[seg.effective] ?? 0;
    const left = x(seg.startAt);
    lines.push({ left: pct(left), width: pct(Math.max(0.15, x(seg.endAt) - left)), top: rowMid(row) - LINE_PX / 2 });
    const prev = segments[i - 1];
    if (prev) {
      const a = rowMid(ROW_OF[prev.effective] ?? 0);
      const b = rowMid(row);
      if (a !== b) links.push({ left: pct(left), top: Math.min(a, b), height: Math.abs(a - b) });
    }
  });

  // Hour ticks: one column per hour of the (23/24/25 h) day.
  const hours = Math.max(1, Math.round(day.dayLengthSec / 3600));
  // `{{#each}}` bodies only see the item's own fields, so the width/height ride on every item.
  const hourWidth = pct(100 / hours);
  const hourLabels = Array.from({ length: hours }, (_v, h) => ({ label: h === 0 ? 'Mid' : h === 12 ? 'Noon' : String(h % 12), width: hourWidth }));

  const totals = [day.offDutySec, day.sleeperSec, day.drivingSec, day.onDutySec].map(hm);
  const rowTotals = ROW_LABEL.map((label, i) => ({ label, total: totals[i], height: GRAPH_ROW_HEIGHT_PX }));

  const remarks = segments.map((seg) => ({
    time: seg.carriedOver && seg.startAt.getTime() <= startMs ? '00:00 (carried over)' : clock(day.timezone, seg.startAt),
    status: seg.special === 'NONE' || !seg.special ? seg.status : `${seg.status} (${seg.special})`,
    duration: hm(seg.durationSec),
    location: seg.locationDescription ?? '',
    odometer: seg.odometerMi ?? '',
    annotation: seg.annotation ?? '',
  }));

  const odometers = segments.map((s) => s.odometerMi).filter((v): v is number => typeof v === 'number');
  return {
    date: day.logDate,
    timezone: day.timezone,
    dayLengthHours: hm(day.dayLengthSec),
    driverName: `${driver.lastName}, ${driver.firstName}`,
    driverLicense: `${driver.cdlNumber} (${driver.cdlState})`,
    homeTerminal: driver.homeTerminalName,
    carrierName: carrier?.name ?? '',
    carrierDot: carrier?.dotNumber ?? '',
    carrierAddress: carrier?.address ?? '',
    vehicles: input.vehicles.map((v) => `${v.unitNumber} (VIN ${v.vin})`).join(', ') || '—',
    trailers: input.trailerNumbers.join(', ') || '—',
    shippingDocuments: input.shippingDocuments.join(', ') || '—',
    totalMiles: day.totalDistanceMi,
    startOdometer: odometers.length ? Math.min(...odometers) : '',
    endOdometer: odometers.length ? Math.max(...odometers) : '',
    totalHours: hm(day.accountedSec),
    graphHeight: GRAPH_ROW_HEIGHT_PX * 4,
    rowTotals,
    hourLabels,
    lines,
    links,
    remarks,
    certified: input.certified ? `Yes${input.certifiedAt ? ` — ${input.certifiedAt.toISOString()}` : ''}` : 'No',
    hasEdits: day.hasEdits ? 'Yes' : 'No',
    generatedAt: input.generatedAt.toISOString(),
  };
}
