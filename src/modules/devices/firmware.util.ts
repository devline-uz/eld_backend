/**
 * TZ §5.4 — "Firmware talabi: Virtual Dashboard uchun PT30 ≥ L108 (tavsiya L113)."
 * Firmware strings are a letter + zero-padded number, e.g. "L113". Pure function so it's
 * unit-testable without touching the DB.
 */
export const MIN_PT30_FIRMWARE = 'L108';
export const RECOMMENDED_PT30_FIRMWARE = 'L113';

function parseFirmware(firmware: string): number | null {
  const match = /^[A-Za-z](\d+)$/.exec(firmware.trim());
  return match ? Number(match[1]) : null;
}

/** True when `firmware` is below `minimum` (or unparsable — treated as outdated). */
export function isFirmwareOutdated(firmware: string | null | undefined, minimum: string = MIN_PT30_FIRMWARE): boolean {
  if (!firmware) return true;
  const current = parseFirmware(firmware);
  const min = parseFirmware(minimum);
  if (current === null || min === null) return true;
  return current < min;
}
