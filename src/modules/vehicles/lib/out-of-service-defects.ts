import type { DefectStatus, Prisma } from '@prisma/client';

/**
 * TZ §5.10 out-of-service rule — the single definition of "a defect that still holds its unit out
 * of service" (QA CODE-008). A CRITICAL / out-of-service defect keeps holding the unit until it is
 * actually repaired (or found not to need repair): `DEFERRED` postpones the repair, it does NOT
 * clear the defect, so a deferred critical defect keeps the unit `OUT_OF_SERVICE` exactly like an
 * `OPEN` or `IN_PROGRESS` one. Only `REPAIRED` releases the hold.
 *
 * Shared by `DefectsService` (auto-restore on resolve), `syncVehicleOutOfService` (work-order
 * release) and `VehiclesService` (the manual "cannot leave OUT_OF_SERVICE" guard) so the three
 * paths can never disagree about which defects block a unit.
 */
export const OUT_OF_SERVICE_HOLDING_DEFECT_STATUSES: DefectStatus[] = ['OPEN', 'IN_PROGRESS', 'DEFERRED'];

/** A defect is out-of-service when it is CRITICAL or explicitly flagged `outOfService` (the DVIR
 * submission sets the flag from the severity, so the two normally coincide). */
export function isOutOfServiceDefect(defect: { severity: string; outOfService?: boolean | null }): boolean {
  return defect.severity === 'CRITICAL' || defect.outOfService === true;
}

/** Whether this defect, in its current state, holds its unit out of service. */
export function holdsVehicleOutOfService(defect: { severity: string; outOfService?: boolean | null; status: DefectStatus }): boolean {
  return isOutOfServiceDefect(defect) && OUT_OF_SERVICE_HOLDING_DEFECT_STATUSES.includes(defect.status);
}

/** Prisma filter for the defects on `vehicleId` that still hold it out of service. */
export function outOfServiceHoldingDefectsWhere(vehicleId: string): Prisma.DefectWhereInput {
  return {
    vehicleId,
    status: { in: OUT_OF_SERVICE_HOLDING_DEFECT_STATUSES },
    OR: [{ severity: 'CRITICAL' }, { outOfService: true }],
  };
}
