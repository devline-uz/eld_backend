import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { LOGIN_CODE } from './event-codes';

/**
 * D-164 — `/ingest/*` refusal semantics for the app's retry policy (backend-tasks 2026-10-15 §2.10):
 * 5xx/408/429/401 are retried with backoff honouring `Retry-After`; every other 4xx is permanent
 * (the app quarantines the rows). A refusal is therefore 403 only when something real conflicts
 * with the claim; "the association is just not visible yet" is 503 + `Retry-After`.
 */

/** `Retry-After` for `INGEST_ASSIGNMENT_PENDING`. */
export const ASSIGNMENT_PENDING_RETRY_AFTER_SEC = 30;
/** A logout from the claimed unit older than this means the driver left it — real refusal. */
export const LEFT_UNIT_GRACE_MS = 10 * 60_000;

export type AssociationRefusal =
  | 'DEVICE_PAIRED_ELSEWHERE'
  | 'UNIT_HAS_OTHER_DEVICE'
  | 'UNIT_ASSIGNED_TO_ANOTHER_DRIVER'
  | 'DRIVER_ASSIGNED_TO_ANOTHER_UNIT'
  | 'DRIVER_LEFT_UNIT';

export interface AssociationState {
  holder: { id: string; status: string } | null;
  driverAssignedVehicleId: string | null;
  pairedDeviceId: string | null;
  lastSession: { eventCode: number; eventDateTime: Date } | null;
}

/**
 * The driver is neither assigned to the claimed unit nor logged in on it (fast check). Decides from
 * a FRESH re-read: `visible` (the association landed meanwhile), `pending` (nothing conflicts —
 * e.g. a select-vehicle write still in flight), or a real refusal reason.
 */
export function classifyDriverMiss(
  state: AssociationState,
  driverId: string,
  vehicleId: string,
  now: Date,
): 'visible' | 'pending' | AssociationRefusal {
  if (state.holder?.id === driverId || state.driverAssignedVehicleId === vehicleId) return 'visible';
  if (state.lastSession?.eventCode === LOGIN_CODE.LOGIN && state.lastSession.eventDateTime <= now) return 'visible';
  if (state.holder && state.holder.status === 'ACTIVE') return 'UNIT_ASSIGNED_TO_ANOTHER_DRIVER';
  if (state.driverAssignedVehicleId) return 'DRIVER_ASSIGNED_TO_ANOTHER_UNIT';
  if (
    state.lastSession?.eventCode === LOGIN_CODE.LOGOUT &&
    now.getTime() - state.lastSession.eventDateTime.getTime() > LEFT_UNIT_GRACE_MS
  ) {
    return 'DRIVER_LEFT_UNIT';
  }
  return 'pending';
}

/** The device row is unpaired but the payload claims a unit: who (if anyone) holds that unit. */
export function classifyDeviceMiss(state: AssociationState, deviceId: string): 'visible' | 'pending' | AssociationRefusal {
  if (state.pairedDeviceId === deviceId) return 'visible';
  if (state.pairedDeviceId) return 'UNIT_HAS_OTHER_DEVICE';
  return 'pending';
}

const REFUSAL_MESSAGES: Record<AssociationRefusal, string> = {
  DEVICE_PAIRED_ELSEWHERE: 'Device is not paired with the claimed unit.',
  UNIT_HAS_OTHER_DEVICE: 'The claimed unit has another device paired.',
  UNIT_ASSIGNED_TO_ANOTHER_DRIVER: 'Driver is not associated with this unit: it is assigned to another driver.',
  DRIVER_ASSIGNED_TO_ANOTHER_UNIT: 'Driver is not associated with this unit: the driver is assigned to another unit.',
  DRIVER_LEFT_UNIT: 'Driver is not associated with this unit: the driver logged out of it.',
};

/** 403 FORBIDDEN — permanent for the app (quarantine). `details.reason` names the conflict. */
export function associationRefused(
  reason: AssociationRefusal,
  details: { deviceSerial: string; vehicleId: string },
): AppException {
  return AppException.forbidden(REFUSAL_MESSAGES[reason], { ...details, reason });
}

/** 503 INGEST_ASSIGNMENT_PENDING — transient; the filter adds `Retry-After` from `retryAfterSec`. */
export function assignmentPending(
  pending: Array<'DEVICE_PAIRING' | 'DRIVER_ASSIGNMENT'>,
  details: { deviceSerial: string; vehicleId: string },
): AppException {
  return new AppException(
    ERROR_CODES.INGEST_ASSIGNMENT_PENDING,
    'The unit assignment is not visible yet — retry after the Retry-After delay.',
    HttpStatus.SERVICE_UNAVAILABLE,
    { ...details, pending, retryAfterSec: ASSIGNMENT_PENDING_RETRY_AFTER_SEC },
  );
}
