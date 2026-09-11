import { RECORD_ORIGIN } from './event-codes';

/**
 * TZ §7.4 — who owns an event that sat in the PT30's memory while BLE was down.
 *
 * The three rules are ORDERED: the first match wins and the rest are never evaluated.
 * `recordOrigin` NEVER becomes 2 here — the ELD recorded these events automatically; a driver
 * merely acknowledging them must not make the record look driver-entered (§395.30, §7.4).
 */

/** Rule 2's window: the same driver before AND after the gap, gap ≤ 2 hours. */
export const REJOIN_GAP_MAX_SEC = 2 * 60 * 60;

export interface DriverActivity {
  driverId: string;
  at: Date;
}

export interface UnitSessionWindow {
  /**
   * Rule 1 — a driver who logged in on this unit before the event and had not logged out by
   * the time of the event. `null` when no session was open.
   */
  openSessionDriverId: string | null;
  /** Rule 2 — last driver seen on this unit strictly before the event (their logout). */
  lastBefore: DriverActivity | null;
  /** Rule 2 — first driver seen on this unit at or after the event (their next login). */
  firstAfter: DriverActivity | null;
}

export interface OwnershipDecision {
  driverId: string | null;
  recordOrigin: (typeof RECORD_ORIGIN)[keyof typeof RECORD_ORIGIN];
  /** Which §7.4 rule fired — surfaced in the ingest response and logged. */
  rule: 1 | 2 | 3;
  /** Rule 2 only: the driver gets a push + in-app banner to confirm or reject. */
  requiresConfirmation: boolean;
  /** Rule 3 only: an `UnidentifiedSegment` must be created for these events. */
  createsUnidentifiedSegment: boolean;
}

/**
 * Resolves ownership for ONE device-stored event. Pure — all lookups happen in the repository
 * and are handed in through `window`.
 */
export function resolveStoredEventOwner(
  eventAt: Date,
  window: UnitSessionWindow,
): OwnershipDecision {
  // Rule 1 — an open session covers the gap. The driver is not disturbed at all.
  if (window.openSessionDriverId) {
    return {
      driverId: window.openSessionDriverId,
      recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
      rule: 1,
      requiresConfirmation: false,
      createsUnidentifiedSegment: false,
    };
  }

  // Rule 2 — same driver on both sides of a gap of at most two hours.
  const { lastBefore, firstAfter } = window;
  if (lastBefore && firstAfter && lastBefore.driverId === firstAfter.driverId) {
    const gapSec = Math.abs(firstAfter.at.getTime() - lastBefore.at.getTime()) / 1000;
    const bracketsEvent =
      lastBefore.at.getTime() <= eventAt.getTime() && eventAt.getTime() <= firstAfter.at.getTime();
    if (gapSec <= REJOIN_GAP_MAX_SEC && bracketsEvent) {
      return {
        driverId: lastBefore.driverId,
        recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
        rule: 2,
        requiresConfirmation: true,
        createsUnidentifiedSegment: false,
      };
    }
  }

  // Rule 3 — everything else is unidentified driving. The events are still stored.
  return {
    driverId: null,
    recordOrigin: RECORD_ORIGIN.UNIDENTIFIED,
    rule: 3,
    requiresConfirmation: false,
    createsUnidentifiedSegment: true,
  };
}
