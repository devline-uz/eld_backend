/** BullMQ queue names. Workers (worker.ts) consume these; the API only enqueues. */
export const QUEUES = {
  HOS_RECALC: 'hos-recalc',
  /** §8.6 — nightly server-vs-app HOS state drift comparison. */
  HOS_DRIFT: 'hos-drift',
  REPORT: 'report',
  TRANSFER: 'transfer',
  ALERT: 'alert',
  SAFETY_DETECT: 'safety-detect',
  /** §5.10 — nightly due/overdue sweep over `MaintenanceSchedule` (Phase 7, eld-fleet-ops). */
  MAINTENANCE_DUE: 'maintenance-due',
  RETENTION: 'retention',
  WEBHOOK: 'webhook',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
