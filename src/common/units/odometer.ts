/**
 * TZ §4.3 — the PT30 odometer is relative, not absolute.
 * true = device + offset, where offset = odometerMi − deviceOdometerMi at calibration time.
 */
export interface OdometerCalibration {
  /** Dash odometer entered by the user, miles. */
  odometerMi: number;
  /** Last value reported by the PT30, miles. */
  deviceOdometerMi: number;
}

/** Offset computed on the first device reading (or on recalibration). */
export function computeOdometerOffsetMi(c: OdometerCalibration): number {
  return c.odometerMi - c.deviceOdometerMi;
}

/** Applies the stored offset to a device reading. */
export function applyOdometerOffsetMi(deviceOdometerMi: number, offsetMi: number): number {
  return deviceOdometerMi + offsetMi;
}

/** Max plausible daily odometer growth before diagnostic 3 is raised (TZ §4.3). */
export const ODOMETER_MAX_DAILY_JUMP_MI = 2000;

/** True when the device odometer went backwards or jumped implausibly (→ diagnostic 3). */
export function isOdometerAnomaly(previousMi: number, currentMi: number): boolean {
  return currentMi < previousMi || currentMi - previousMi > ODOMETER_MAX_DAILY_JUMP_MI;
}
