import { kmhToMph } from '../../../common/units';

/**
 * TZ §11.5 (`GET /safety/events`) — harsh-event detection off consecutive telemetry points.
 * Pure and deterministic: same input points always produce the same events, per tasks.md
 * "safety scoring must be reproducible" (documented D-0xx in decisions.md).
 *
 * Thresholds (not in tz.md — no accelerometer/g-force spec is given, so this reuses the
 * industry-standard delta-speed proxy commercial ELD/telematics vendors publish):
 *   - harsh braking: speed drop >= 8 mph within <= 2 s
 *   - harsh acceleration: speed gain >= 8 mph within <= 2 s
 *   - harsh turn: heading change >= 45 deg within <= 2 s while moving >= 15 mph
 */
export const HARSH_SPEED_DELTA_MPH = 8;
export const HARSH_MAX_WINDOW_SEC = 2;
export const HARSH_TURN_DELTA_DEG = 45;
export const HARSH_TURN_MIN_SPEED_MPH = 15;
/** CODE-039 — a qualifying step within this many seconds of the previous one of the same type
 * continues that manoeuvre (60 → 20 mph over 4 s at 1 Hz is ONE harsh braking, not four). */
export const HARSH_EPISODE_GAP_SEC = 5;

export interface TelemetrySample {
  time: Date;
  speedMph: number | null;
  headingDeg: number | null;
  /** `null` when the telemetry point had no GPS fix (PT SDK 6.11). */
  latitude: number | null;
  longitude: number | null;
}

export type HarshEventType = 'HARSH_BRAKING' | 'HARSH_ACCEL' | 'HARSH_TURN';

export interface DetectedHarshEvent {
  type: HarshEventType;
  occurredAt: Date;
  speedMph: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Proxy severity 1-5, derived from how far past the threshold the delta went. */
  severity: number;
}

function severityFromDelta(delta: number, threshold: number): number {
  const ratio = delta / threshold;
  return Math.max(1, Math.min(5, Math.round(ratio * 2)));
}

function headingDelta(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Runs the three detectors across an ORDERED sample sequence for a single vehicle. Consecutive
 * qualifying steps of one type form one episode (CODE-039): one event at the episode's first
 * step, with the highest severity seen during it. */
export function detectHarshEvents(samples: TelemetrySample[]): DetectedHarshEvent[] {
  const events: DetectedHarshEvent[] = [];
  const lastStepAt = new Map<HarshEventType, { at: number; event: DetectedHarshEvent }>();
  const record = (type: HarshEventType, cur: TelemetrySample, severity: number) => {
    const open = lastStepAt.get(type);
    const at = cur.time.getTime();
    if (open && at - open.at <= HARSH_EPISODE_GAP_SEC * 1000) {
      open.event.severity = Math.max(open.event.severity, severity);
      open.at = at;
      return;
    }
    const event: DetectedHarshEvent = {
      type,
      occurredAt: cur.time,
      speedMph: cur.speedMph,
      latitude: cur.latitude,
      longitude: cur.longitude,
      severity,
    };
    events.push(event);
    lastStepAt.set(type, { at, event });
  };

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dtSec = (cur.time.getTime() - prev.time.getTime()) / 1000;
    if (dtSec <= 0 || dtSec > HARSH_MAX_WINDOW_SEC) continue;

    if (prev.speedMph !== null && cur.speedMph !== null) {
      const delta = cur.speedMph - prev.speedMph;
      if (-delta >= HARSH_SPEED_DELTA_MPH) {
        record('HARSH_BRAKING', cur, severityFromDelta(-delta, HARSH_SPEED_DELTA_MPH));
      } else if (delta >= HARSH_SPEED_DELTA_MPH) {
        record('HARSH_ACCEL', cur, severityFromDelta(delta, HARSH_SPEED_DELTA_MPH));
      }
    }

    if (
      prev.headingDeg !== null &&
      cur.headingDeg !== null &&
      cur.speedMph !== null &&
      cur.speedMph >= HARSH_TURN_MIN_SPEED_MPH
    ) {
      const delta = headingDelta(prev.headingDeg, cur.headingDeg);
      if (delta >= HARSH_TURN_DELTA_DEG) record('HARSH_TURN', cur, severityFromDelta(delta, HARSH_TURN_DELTA_DEG));
    }
  }
  return events;
}

/** Converts a raw km/h telemetry point into the mph-based sample the detector expects. */
export function toSample(point: {
  time: Date;
  speedKmh?: number | null;
  headingDeg?: number | null;
  latitude?: number | null;
  longitude?: number | null;
}): TelemetrySample {
  const located = point.latitude != null && point.longitude != null;
  return {
    time: point.time,
    speedMph: point.speedKmh != null ? kmhToMph(point.speedKmh) : null,
    headingDeg: point.headingDeg ?? null,
    latitude: located ? point.latitude! : null,
    longitude: located ? point.longitude! : null,
  };
}

// ---------------------------------------------------------------------------
// Driver scoring (TZ §11.5 `/safety/scorecard`, "Safety" Figma screen)
// ---------------------------------------------------------------------------

/** D-141 — a driver with fewer miles than this in the period gets no score ("Not enough miles"). */
export const MIN_SCORED_MILES = 100;

/** D-141 — points deducted per event, per 1,000 miles driven. */
export const SCORE_WEIGHTS = { harsh: 2, speeding: 1.5, seatbelt: 3, hosViolation: 5 } as const;

/**
 * D-141 — harsh-event severity multiplier: 4–5 Critical ×4, 3 Major ×2, 1–2 Minor ×1. Severity
 * outside 1–5 is clamped into it, so a bad row can never zero or explode the deduction.
 */
export function severityFactor(severity: number): number {
  const s = Math.max(1, Math.min(5, Math.round(severity)));
  if (s >= 4) return 4;
  if (s === 3) return 2;
  return 1;
}

export interface ScoreInput {
  /** Harsh braking/accel/turn events, grouped by severity (`count` events at `severity`). */
  harsh: ReadonlyArray<{ severity: number; count: number }>;
  speedingCount: number;
  seatbeltCount: number;
  /** HOS violations in the period. */
  violationCount: number;
  milesDriven: number;
}

/**
 * TZ eld.docs/web §9 — "Fleet safety score 0-100, below 70 needs attention". No formula is
 * specified, so this is the documented, reproducible points-deduction model of D-033 as revised
 * by D-141 (Phase 1 scorecards):
 *
 *   milesK    = milesDriven / 1000
 *   deduction = Σ harsh × 2 × severityFactor + speeding × 1.5 + seatbelt × 3 + HOS violations × 5
 *   score     = clamp(round(100 − deduction / milesK), 0, 100)
 *
 * Returns `null` (no score) when `milesDriven < MIN_SCORED_MILES` — a handful of miles would turn
 * one event into a 0 and is not a meaningful rate. Pure and deterministic.
 */
export function computeDriverScore(input: ScoreInput): number | null {
  if (!(input.milesDriven >= MIN_SCORED_MILES)) return null;
  const milesK = input.milesDriven / 1000;
  const harshPoints = input.harsh.reduce((sum, h) => sum + h.count * SCORE_WEIGHTS.harsh * severityFactor(h.severity), 0);
  const deduction =
    harshPoints +
    input.speedingCount * SCORE_WEIGHTS.speeding +
    input.seatbeltCount * SCORE_WEIGHTS.seatbelt +
    input.violationCount * SCORE_WEIGHTS.hosViolation;
  return Math.max(0, Math.min(100, Math.round(100 - deduction / milesK)));
}
