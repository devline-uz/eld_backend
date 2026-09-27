import { z } from 'zod';

export const DefectStatusEnum = z.enum(['OPEN', 'IN_PROGRESS', 'REPAIRED', 'DEFERRED']);
export const DefectSeverityEnum = z.enum(['MINOR', 'MAJOR', 'CRITICAL']);
/** §20 B-68 — distinct from `DefectStatusEnum` so "no repair needed" is never recorded as REPAIRED
 * in the §396.11 record (report generators must read `resolutionType`, not `status`, for display). */
export const DefectResolutionTypeEnum = z.enum(['REPAIRED', 'NOT_REQUIRED', 'DEFERRED']);
export const WorkOrderStatusEnum = z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
export const WorkOrderPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const RepairStatusEnum = z.enum(['NOT_REQUIRED', 'PENDING', 'REPAIRED', 'DEFERRED']);

// --- DVIR (web read + mechanic sign-off) ------------------------------------------------

export const DvirListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  vehicleId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  repairStatus: RepairStatusEnum.optional(),
  /** §20 B-47. */
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export type DvirListQueryDto = z.infer<typeof DvirListQueryDto>;

/** §20 B-47 — `GET /dvir/compliance`: "expected vs submitted pre-trip DVIRs" for the active
 * fleet over a date range (W-14 "Missing pre-trip" / "Not submitted" rows, compliance % chip). */
export const DvirComplianceQueryDto = z.object({
  from: z.string().date(),
  to: z.string().date(),
});
export type DvirComplianceQueryDto = z.infer<typeof DvirComplianceQueryDto>;

/** TZ §396.13 — mechanic reviews defects found on a DVIR and signs off; the next driver's
 * review of that sign-off is recorded separately (`nextDriverReviewedAt`). */
export const MechanicSignOffDto = z.object({
  mechanicName: z.string().min(1).max(120),
  mechanicNote: z.string().max(500).optional(),
  repairStatus: RepairStatusEnum,
});
export type MechanicSignOffDto = z.infer<typeof MechanicSignOffDto>;

export const NextDriverReviewDto = z.object({
  reviewedAt: z.string().datetime({ offset: true }).optional(),
});
export type NextDriverReviewDto = z.infer<typeof NextDriverReviewDto>;

// --- Defects -----------------------------------------------------------------------------

export const DefectListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  vehicleId: z.string().uuid().optional(),
  status: DefectStatusEnum.optional(),
  severity: DefectSeverityEnum.optional(),
  outOfService: z.coerce.boolean().optional(),
  /** §20 B-40. */
  assigneeId: z.string().uuid().optional(),
});
export type DefectListQueryDto = z.infer<typeof DefectListQueryDto>;

/**
 * Resolving a defect is the trigger for the out-of-service restore check (TZ §5.10 — "Defekt
 * yopilganda status avtomatik tiklanadi"). §20 B-68 — `resolutionType: 'NOT_REQUIRED'` records
 * that no repair was needed without ever writing `REPAIRED` into the §396.11 record for a
 * defect nothing was done to. §20 B-70 — the repair-record fields (`correctedBy`, `completedAt`,
 * `laborHours`, `partsCostUsd`) complete that record.
 */
export const ResolveDefectDto = z.object({
  resolutionType: DefectResolutionTypeEnum,
  resolutionNote: z.string().max(500).optional(),
  correctedBy: z.string().max(120).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
  laborHours: z.number().min(0).max(999).optional(),
  partsCostUsd: z.number().min(0).max(1_000_000).optional(),
});
export type ResolveDefectDto = z.infer<typeof ResolveDefectDto>;

export const LinkDefectWorkOrderDto = z.object({
  workOrderId: z.string().uuid().nullable(),
});
export type LinkDefectWorkOrderDto = z.infer<typeof LinkDefectWorkOrderDto>;

/** §20 B-40 — defect assignee/shop (`W-09 ASSIGNED TO`). `null` clears the assignment. */
export const AssignDefectDto = z.object({
  assigneeId: z.string().uuid().nullable(),
});
export type AssignDefectDto = z.infer<typeof AssignDefectDto>;

// --- Work orders -------------------------------------------------------------------------

export const CreateWorkOrderDto = z.object({
  vehicleId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: WorkOrderPriorityEnum.default('NORMAL'),
  vendor: z.string().max(120).optional(),
  costUsd: z.number().min(0).max(1_000_000).optional(),
  odometerMi: z.number().int().min(0).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  /** Open defects to attach at creation time — TZ §5.10 "Create work order" screen. */
  defectIds: z.array(z.string().uuid()).max(50).optional(),
  /** §20 B-42. */
  estimatedLaborHours: z.number().min(0).max(999).optional(),
  keepOutOfService: z.boolean().default(false),
  notifyDriver: z.boolean().default(true),
  blockDispatchAssignment: z.boolean().default(false),
});
export type CreateWorkOrderDto = z.infer<typeof CreateWorkOrderDto>;

export const UpdateWorkOrderDto = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  priority: WorkOrderPriorityEnum.optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS']).optional(),
  vendor: z.string().max(120).optional(),
  costUsd: z.number().min(0).max(1_000_000).optional(),
  odometerMi: z.number().int().min(0).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** §20 B-42. */
  estimatedLaborHours: z.number().min(0).max(999).optional(),
  keepOutOfService: z.boolean().optional(),
  notifyDriver: z.boolean().optional(),
  blockDispatchAssignment: z.boolean().optional(),
});
export type UpdateWorkOrderDto = z.infer<typeof UpdateWorkOrderDto>;

export const WorkOrderListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  vehicleId: z.string().uuid().optional(),
  status: WorkOrderStatusEnum.optional(),
  priority: WorkOrderPriorityEnum.optional(),
});
export type WorkOrderListQueryDto = z.infer<typeof WorkOrderListQueryDto>;

// --- Maintenance schedules -----------------------------------------------------------------

export const CreateMaintenanceScheduleDto = z
  .object({
    vehicleId: z.string().uuid(),
    name: z.string().min(1).max(120),
    intervalMi: z.number().int().min(1).max(2_000_000).optional(),
    intervalDays: z.number().int().min(1).max(3660).optional(),
    lastServiceMi: z.number().int().min(0).optional(),
    lastServiceAt: z.string().datetime({ offset: true }).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.intervalMi !== undefined || v.intervalDays !== undefined, {
    message: 'At least one of intervalMi/intervalDays is required.',
  });
export type CreateMaintenanceScheduleDto = z.infer<typeof CreateMaintenanceScheduleDto>;

export const UpdateMaintenanceScheduleDto = z.object({
  name: z.string().min(1).max(120).optional(),
  intervalMi: z.number().int().min(1).max(2_000_000).nullable().optional(),
  intervalDays: z.number().int().min(1).max(3660).nullable().optional(),
  lastServiceMi: z.number().int().min(0).optional(),
  lastServiceAt: z.string().datetime({ offset: true }).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateMaintenanceScheduleDto = z.infer<typeof UpdateMaintenanceScheduleDto>;

export const MaintenanceScheduleListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  vehicleId: z.string().uuid().optional(),
  enabled: z.coerce.boolean().optional(),
  dueOnly: z.coerce.boolean().optional(),
});
export type MaintenanceScheduleListQueryDto = z.infer<typeof MaintenanceScheduleListQueryDto>;

/** Marks a schedule serviced now — resets `lastService*`/`nextDue*` from the interval. */
export const CompleteMaintenanceDto = z.object({
  serviceOdometerMi: z.number().int().min(0).optional(),
  serviceAt: z.string().datetime({ offset: true }).optional(),
});
export type CompleteMaintenanceDto = z.infer<typeof CompleteMaintenanceDto>;
