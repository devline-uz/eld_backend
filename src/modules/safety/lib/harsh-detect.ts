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

/** Runs the three detectors across an ORDERED sample sequence for a single vehicle. */
export function detectHarshEvents(samples: TelemetrySample[]): DetectedHarshEvent[] {
  const events: DetectedHarshEvent[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dtSec = (cur.time.getTime() - prev.time.getTime()) / 1000;
    if (dtSec <= 0 || dtSec > HARSH_MAX_WINDOW_SEC) continue;

    if (prev.speedMph !== null && cur.speedMph !== null) {
      const delta = cur.speedMph - prev.speedMph;
      if (-delta >= HARSH_SPEED_DELTA_MPH) {
        events.push({
          type: 'HARSH_BRAKING',
          occurredAt: cur.time,
          speedMph: cur.speedMph,
          latitude: cur.latitude,
          longitude: cur.longitude,
          severity: severityFromDelta(-delta, HARSH_SPEED_DELTA_MPH),
        });
      } else if (delta >= HARSH_SPEED_DELTA_MPH) {
        events.push({
          type: 'HARSH_ACCEL',
          occurredAt: cur.time,
          speedMph: cur.speedMph,
          latitude: cur.latitude,
          longitude: cur.longitude,
          severity: severityFromDelta(delta, HARSH_SPEED_DELTA_MPH),
        });
      }
    }

    if (
      prev.headingDeg !== null &&
      cur.headingDeg !== null &&
      cur.speedMph !== null &&
      cur.speedMph >= HARSH_TURN_MIN_SPEED_MPH
    ) {
      const delta = headingDelta(prev.headingDeg, cur.headingDeg);
      if (delta >= HARSH_TURN_DELTA_DEG) {
        events.push({
          type: 'HARSH_TURN',
          occurredAt: cur.time,
          speedMph: cur.speedMph,
          latitude: cur.latitude,
          longitude: cur.longitude,
          severity: severityFromDelta(delta, HARSH_TURN_DELTA_DEG),
        });
      }
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

export interface ScoreInput {
  harshCount: number;
  speedingCount: number;
  milesDriven: number;
  violationCount: number;
}

/**
 * TZ eld.docs/web §9 — "Fleet safety score 0-100, below 70 needs attention". No formula is
 * specified, so this implements a documented, reproducible points-deduction model
 * (D-0xx): start at 100, deduct per event normalised per 1,000 miles driven so a
 * high-mileage driver isn't penalised more than a low-mileage one for the same event rate.
 */
export function computeDriverScore(input: ScoreInput): number {
  const milesK = Math.max(input.milesDriven, 1) / 1000;
  const deduction =
    (input.harshCount / milesK) * 2 +
    (input.speedingCount / milesK) * 1.5 +
    (input.violationCount / milesK) * 5;
  return Math.max(0, Math.min(100, Math.round(100 - deduction)));
}
