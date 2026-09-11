/** BullMQ queue names. Workers (worker.ts) consume these; the API only enqueues. */
export const QUEUES = {
  HOS_RECALC: 'hos-recalc',
  /** §8.6 — nightly server-vs-app HOS state drift comparison. */
  HOS_DRIFT: 'hos-drift',
  REPORT: 'report',
  /** §15 — self-scheduling minute tick that scans `ReportSchedule` and enqueues due
   * `report.generate` jobs into REPORT. A separate queue from REPORT itself so the tick's
   * own worker never accidentally consumes a `report.generate` job (Phase 8). */
  REPORT_SCHEDULER: 'report-scheduler',
  /** §15 — nightly per-jurisdiction `IftaSegment` computation from telemetry (Phase 8). */
  IFTA_NIGHTLY: 'ifta-nightly',
  TRANSFER: 'transfer',
  ALERT: 'alert',
  SAFETY_DETECT: 'safety-detect',
  /** §5.10 — nightly due/overdue sweep over `MaintenanceSchedule` (Phase 7, eld-fleet-ops). */
  MAINTENANCE_DUE: 'maintenance-due',
  RETENTION: 'retention',
  WEBHOOK: 'webhook',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
