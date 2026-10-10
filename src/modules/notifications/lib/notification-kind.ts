import { NotificationKind } from '@prisma/client';

/**
 * TZ §14 / mobile TZ §21 — derives the mobile-app filter bucket (`Notification.kind`) from
 * the triggering `alert.*` job name (BullMQ job.name in AlertProcessor). Pure/deterministic
 * so it is unit-testable without touching the DB. `type` (rule id / legacy string) is left
 * untouched (D-072) — `kind` is purely additive.
 */
export function deriveNotificationKind(eventName: string): NotificationKind {
  if (eventName === 'alert.hos_violation') return NotificationKind.VIOLATION;
  if (eventName.startsWith('alert.break_')) return NotificationKind.WARNING;
  if (eventName === 'alert.edit_request' || eventName === 'log.edit_requested') return NotificationKind.EDIT_REQUEST;
  if (eventName === 'message.new' || eventName.startsWith('message.')) return NotificationKind.MESSAGE;
  if (eventName === 'alert.trip_assigned') return NotificationKind.TRIP;
  if (eventName.startsWith('alert.unidentified_')) return NotificationKind.UNIDENTIFIED;
  if (eventName === 'alert.uncertified_logs' || eventName.startsWith('alert.certify')) return NotificationKind.CERTIFY;
  if (eventName.startsWith('alert.maintenance_')) return NotificationKind.MAINTENANCE;
  if (eventName.startsWith('alert.eld_') || eventName.startsWith('alert.device_')) return NotificationKind.DEVICE;
  return NotificationKind.OTHER;
}

/**
 * TZ §20 B-57 — the two segments `web/features/notifications/NotificationsPanel.tsx` renders
 * (`All` / `Violations` / `Maintenance`). Compliance-risk kinds (a violation itself, a break
 * warning, an uncertified-log nag, an unidentified-driving alert) bucket to `VIOLATIONS`;
 * equipment-health kinds (maintenance due, device/ELD trouble) bucket to `MAINTENANCE`.
 * Dispatch/messaging/edit-request/other kinds have no segment — they still count in `all`.
 */
export function deriveNotificationCategory(kind: NotificationKind): 'VIOLATIONS' | 'MAINTENANCE' | undefined {
  switch (kind) {
    case NotificationKind.VIOLATION:
    case NotificationKind.WARNING:
    case NotificationKind.CERTIFY:
    case NotificationKind.UNIDENTIFIED:
      return 'VIOLATIONS';
    case NotificationKind.MAINTENANCE:
    case NotificationKind.DEVICE:
      return 'MAINTENANCE';
    default:
      return undefined;
  }
}

export interface ObjectRef {
  objectType: string;
  objectId: string;
}

/**
 * Best-effort `objectType`/`objectId` for the notification, derived from the same payload
 * the alert rule matched on (§14 seed table conditions). Follows the PascalCase model-name
 * convention already used by AuditLog (`writeAudit`, `unidentified.service.ts`, etc.).
 * Returns `undefined` when the payload doesn't carry an identifiable subject entity.
 */
export function deriveObjectRef(eventName: string, payload: Record<string, unknown>): ObjectRef | undefined {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

  if (eventName === 'alert.edit_request') {
    const id = str(payload.requestId);
    return id ? { objectType: 'EldEvent', objectId: id } : undefined;
  }
  if (eventName === 'alert.trip_assigned') {
    const id = str(payload.tripId);
    return id ? { objectType: 'Trip', objectId: id } : undefined;
  }
  if (eventName === 'alert.vehicle_out_of_service') {
    const id = str(payload.dvirId);
    return id ? { objectType: 'Dvir', objectId: id } : undefined;
  }
  if (eventName === 'alert.maintenance_due') {
    const id = str(payload.scheduleId);
    return id ? { objectType: 'MaintenanceSchedule', objectId: id } : undefined;
  }
  if (eventName.startsWith('alert.unidentified_')) {
    const segmentId = str(payload.segmentId);
    if (segmentId) return { objectType: 'UnidentifiedSegment', objectId: segmentId };
    const vehicleId = str(payload.vehicleId);
    return vehicleId ? { objectType: 'Vehicle', objectId: vehicleId } : undefined;
  }
  if (eventName === 'alert.uncertified_logs' || eventName === 'alert.hos_violation' || eventName === 'alert.hos_engine_drift') {
    const id = str(payload.driverId);
    return id ? { objectType: 'Driver', objectId: id } : undefined;
  }
  if (eventName.startsWith('alert.eld_') || eventName.startsWith('alert.device_')) {
    const id = str(payload.deviceSerial);
    return id ? { objectType: 'Device', objectId: id } : undefined;
  }
  if (eventName === 'alert.odometer_anomaly') {
    const id = str(payload.vehicleId);
    return id ? { objectType: 'Vehicle', objectId: id } : undefined;
  }
  return undefined;
}

/**
 * TZ §20 B-58 — a human-readable sentence for the notification row + the CRITICAL toast,
 * replacing `JSON.stringify(payload)` (the previous body — unreadable and un-clickable in
 * spirit even once `objectType`/`objectId` made the row clickable). Pure/deterministic like
 * its `deriveNotificationKind`/`deriveObjectRef` neighbours.
 */
export function deriveNotificationBody(eventName: string, payload: Record<string, unknown>): string {
  if (typeof payload.message === 'string' && payload.message.trim().length > 0) return payload.message;

  switch (true) {
    case eventName === 'alert.hos_violation':
      return 'An HOS violation was detected.';
    case eventName.startsWith('alert.break_'):
      return 'A required break is coming up.';
    case eventName === 'alert.edit_request' || eventName === 'log.edit_requested':
      return 'A log edit was requested and needs review.';
    case eventName === 'alert.trip_assigned':
      return 'A new trip was assigned.';
    case eventName === 'alert.vehicle_out_of_service':
      return 'A DVIR placed a vehicle out of service.';
    case eventName === 'alert.maintenance_due':
      return 'A maintenance schedule is due.';
    case eventName === 'alert.unidentified_confirmation_requested':
      return 'A driver needs to confirm unidentified driving time.';
    case eventName.startsWith('alert.unidentified_'):
      return 'Unidentified driving time was detected.';
    case eventName === 'alert.uncertified_logs':
      return 'Daily logs are uncertified.';
    case eventName === 'alert.hos_engine_drift':
      return 'The recorded engine hours drifted from the ELD reading.';
    case eventName === 'alert.eld_disconnected':
      return 'An ELD device disconnected.';
    case eventName === 'alert.device_backlog':
      return 'A device has a data sync backlog.';
    case eventName === 'alert.device_mac_mismatch':
      return 'A driver app saw an ELD whose BLE MAC does not match the device record.';
    case eventName === 'alert.device_vin_mismatch':
      return 'An ELD reported a VIN that does not match its paired vehicle.';
    case eventName === 'alert.sync_backlog':
      return 'The mobile app has an offline sync backlog.';
    case eventName === 'alert.odometer_anomaly':
      return 'An odometer reading looks inconsistent with recent telemetry.';
    default: {
      const label = eventName.replace(/^alert\./, '').replace(/_/g, ' ');
      return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}.` : 'Alert triggered.';
    }
  }
}
