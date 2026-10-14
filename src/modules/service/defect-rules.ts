import type { Defect, WorkOrder } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';

/** Tolerance for client clocks running slightly ahead when "now" is submitted as a timestamp. */
export const FUTURE_SKEW_MS = 2 * 60_000;

const CLOSED_WORK_ORDER = new Set<WorkOrder['status']>(['DONE', 'CANCELLED']);

/**
 * QA CODE-032 - a defect may only be attached to an open work order of the same unit, and only
 * while it still needs work (OPEN / IN_PROGRESS / DEFERRED). A REPAIRED defect is part of a closed
 * §396.11 record and is never re-linked.
 */
export function assertDefectLinkable(
  defect: Pick<Defect, 'id' | 'vehicleId' | 'status'>,
  workOrder: Pick<WorkOrder, 'id' | 'vehicleId' | 'status'>,
): void {
  if (CLOSED_WORK_ORDER.has(workOrder.status)) {
    throw new AppException(ERROR_CODES.WORK_ORDER_CLOSED, 'Work order is already closed or cancelled.', 409, { workOrderId: workOrder.id });
  }
  if (defect.vehicleId !== workOrder.vehicleId) {
    throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'The defect belongs to a different unit than the work order.', 422, {
      defectId: defect.id,
      workOrderId: workOrder.id,
    });
  }
  if (defect.status === 'REPAIRED') {
    throw new AppException(ERROR_CODES.CONFLICT, 'The defect is already resolved.', 409, { defectId: defect.id });
  }
}

/** QA CODE-032 - a defect cannot be moved off a work order that is already signed off. */
export function assertWorkOrderEditable(workOrder: Pick<WorkOrder, 'id' | 'status'>): void {
  if (CLOSED_WORK_ORDER.has(workOrder.status)) {
    throw new AppException(ERROR_CODES.WORK_ORDER_CLOSED, 'Work order is already closed or cancelled.', 409, { workOrderId: workOrder.id });
  }
}

/**
 * QA CODE-034 - a REPAIRED / NOT_REQUIRED resolution is final (a DEFERRED defect can still be
 * repaired later), and the repair time cannot be in the future or before the defect was reported.
 * Returns the completion time to store.
 */
export function resolveCompletedAt(
  defect: Pick<Defect, 'id' | 'status' | 'createdAt'>,
  completedAtIso: string | undefined,
  now: Date,
): Date {
  if (defect.status === 'REPAIRED') {
    throw new AppException(ERROR_CODES.CONFLICT, 'The defect is already resolved.', 409, { defectId: defect.id });
  }
  if (!completedAtIso) return now;
  const completedAt = new Date(completedAtIso);
  if (completedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    const message = 'Completion time cannot be in the future.';
    throw new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { completedAt: message });
  }
  if (completedAt.getTime() < defect.createdAt.getTime()) {
    const message = 'Completion time cannot be before the defect was reported.';
    throw new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { completedAt: message });
  }
  return completedAt;
}
