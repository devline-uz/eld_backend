/**
 * TZ §20 — stable error-code registry.
 *
 * ⚠️ APPEND-ONLY. Codes are part of the public API contract (mobile app + web panel
 * branch on them). Never rename, never renumber, never delete. Add new codes at the
 * bottom of the relevant block.
 */
export const ERROR_CODES = {
  // --- generic / transport -------------------------------------------------
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // --- auth / rbac (TZ §6) -------------------------------------------------
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  USER_NOT_INVITED: 'USER_NOT_INVITED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ROLE_IMMUTABLE: 'ROLE_IMMUTABLE',
  API_KEY_INVALID: 'API_KEY_INVALID',
  API_KEY_REVOKED: 'API_KEY_REVOKED',
  API_KEY_EXPIRED: 'API_KEY_EXPIRED',
  DRIVER_CONTEXT_REQUIRED: 'DRIVER_CONTEXT_REQUIRED',
  /** B-25 — `AUTH_MODE=production` blocks `POST /auth/login`; the back office must use Google Sign-In. */
  PASSWORD_LOGIN_DISABLED: 'PASSWORD_LOGIN_DISABLED',

  // --- fleet (TZ §5.3, §5.4) ----------------------------------------------
  DRIVER_NOT_FOUND: 'DRIVER_NOT_FOUND',
  /** B-100 — `POST/PATCH /drivers`, import rows: another live driver holds the value.
   * `details: { <field>: message }` with field `username` / `email` / `phone` / `cdlNumber`. */
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  PHONE_TAKEN: 'PHONE_TAKEN',
  CDL_NUMBER_TAKEN: 'CDL_NUMBER_TAKEN',
  /** B-100 — `POST /drivers` `assignedVehicleId` names a unit another live driver already has; the
   * other driver keeps it (reassigning is `POST /vehicles/:id/assign-driver`).
   * `details: { assignedVehicleId }`. */
  VEHICLE_ALREADY_ASSIGNED: 'VEHICLE_ALREADY_ASSIGNED',
  VEHICLE_NOT_FOUND: 'VEHICLE_NOT_FOUND',
  /** `/vehicle-groups/:id`, or a `groupId` on a vehicle write / report filter, that names no group. */
  VEHICLE_GROUP_NOT_FOUND: 'VEHICLE_GROUP_NOT_FOUND',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_ALREADY_PAIRED: 'DEVICE_ALREADY_PAIRED',
  /** MG-BLE-1/2 — `POST /mobile/device/mac`: the device already has a different BLE MAC on record
   * (or the reported MAC belongs to another device). 409; back office is alerted
   * (`alert.device_mac_mismatch`) and the attempt is audited. Pairing stays back-office only. */
  DEVICE_MAC_MISMATCH: 'DEVICE_MAC_MISMATCH',
  VEHICLE_OUT_OF_SERVICE: 'VEHICLE_OUT_OF_SERVICE',
  /** `POST /vehicles` / `PATCH /vehicles/:id` / import row — another live unit has this unit
   * number. `details: { unitNumber }` (backend_tasks.md B-97). */
  UNIT_NUMBER_TAKEN: 'UNIT_NUMBER_TAKEN',
  /** `POST /vehicles` / `PATCH /vehicles/:id` / import row — another live unit has this VIN.
   * `details: { vin }` (backend_tasks.md B-97). */
  VIN_TAKEN: 'VIN_TAKEN',
  /** `POST /vehicles` / `PATCH /vehicles/:id` — the ELD device (`deviceId` serial) is already paired
   * to another live unit. `details: { eldSerial }`. */
  ELD_SERIAL_TAKEN: 'ELD_SERIAL_TAKEN',
  /** `POST /vehicles` / `PATCH /vehicles/:id` — another live unit holds the same plate in the same
   * issuing state (trim/case-insensitive). `details: { licensePlate }`. */
  LICENSE_PLATE_TAKEN: 'LICENSE_PLATE_TAKEN',
  /** §5.10 hard rule — cannot set `Vehicle.status` to a non-OOS value while an OPEN CRITICAL
   * defect exists on the unit. Payload lists the blocking defect ids. */
  VEHICLE_HAS_OPEN_CRITICAL_DEFECTS: 'VEHICLE_HAS_OPEN_CRITICAL_DEFECTS',
  ODOMETER_ANOMALY: 'ODOMETER_ANOMALY',
  ODOMETER_NOT_CALIBRATED: 'ODOMETER_NOT_CALIBRATED',
  IMPORT_FAILED: 'IMPORT_FAILED',
  /** §20 B-94 — `GET/POST/DELETE /drivers/:id/documents`. */
  DRIVER_DOCUMENT_NOT_FOUND: 'DRIVER_DOCUMENT_NOT_FOUND',
  /** §20 B-7 — co-driver pairing not found / already ended. */
  CO_DRIVER_PAIRING_NOT_FOUND: 'CO_DRIVER_PAIRING_NOT_FOUND',

  // --- ingest (TZ §7) ------------------------------------------------------
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  EVENT_SEQUENCE_IMMUTABLE: 'EVENT_SEQUENCE_IMMUTABLE',
  EVENT_OUT_OF_RANGE: 'EVENT_OUT_OF_RANGE',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  UNKNOWN_DEVICE: 'UNKNOWN_DEVICE',

  // --- HOS / RODS (TZ §8, §9) ---------------------------------------------
  DRIVING_TIME_IMMUTABLE: 'DRIVING_TIME_IMMUTABLE',
  LOG_ALREADY_CERTIFIED: 'LOG_ALREADY_CERTIFIED',
  RECERTIFICATION_REQUIRED: 'RECERTIFICATION_REQUIRED',
  EDIT_REQUIRES_DRIVER_APPROVAL: 'EDIT_REQUIRES_DRIVER_APPROVAL',
  EDIT_ALREADY_RESOLVED: 'EDIT_ALREADY_RESOLVED',
  UNCERTIFIED_LOGS: 'UNCERTIFIED_LOGS',
  UNRESOLVED_UNIDENTIFIED: 'UNRESOLVED_UNIDENTIFIED',
  UNIDENTIFIED_ALREADY_ASSIGNED: 'UNIDENTIFIED_ALREADY_ASSIGNED',
  HOS_ENGINE_VERSION_MISMATCH: 'HOS_ENGINE_VERSION_MISMATCH',
  /** MR-23 — PC/YM (`specialCondition`) requested by a driver whose exceptions do not allow it
   * (`Driver.allowPersonalConveyance` / `allowYardMove`, §395.1(e)). 422. */
  SPECIAL_CONDITION_NOT_ALLOWED: 'SPECIAL_CONDITION_NOT_ALLOWED',

  // --- transfers / eRODS (TZ §10) -----------------------------------------
  INVALID_TRANSFER_RECIPIENT: 'INVALID_TRANSFER_RECIPIENT',
  TRANSFER_VALIDATION_FAILED: 'TRANSFER_VALIDATION_FAILED',
  ERODS_TEST_MODE_ONLY: 'ERODS_TEST_MODE_ONLY',
  RANGE_TOO_LARGE: 'RANGE_TOO_LARGE',
  /** §10.4 — `FMCSA_PUBLIC_KEY` missing/unparsable: an email transfer cannot be encrypted. */
  TRANSFER_ENCRYPTION_UNAVAILABLE: 'TRANSFER_ENCRYPTION_UNAVAILABLE',
  /** §10.4 — an email transfer job reached the send step with `encrypted = false`. */
  TRANSFER_NOT_ENCRYPTED: 'TRANSFER_NOT_ENCRYPTED',
  /** The generated output file failed Appendix A validation — never handed to an inspector. */
  OUTPUT_FILE_INVALID: 'OUTPUT_FILE_INVALID',

  // --- DVIR / maintenance (TZ §5.10) --------------------------------------
  DVIR_ALREADY_SIGNED: 'DVIR_ALREADY_SIGNED',
  DEFECT_NOT_RESOLVED: 'DEFECT_NOT_RESOLVED',
  WORK_ORDER_CLOSED: 'WORK_ORDER_CLOSED',
  DVIR_NOT_FOUND: 'DVIR_NOT_FOUND',
  DEFECT_NOT_FOUND: 'DEFECT_NOT_FOUND',
  WORK_ORDER_NOT_FOUND: 'WORK_ORDER_NOT_FOUND',
  MAINTENANCE_SCHEDULE_NOT_FOUND: 'MAINTENANCE_SCHEDULE_NOT_FOUND',

  // --- notifications / messaging (TZ §14) ---------------------------------
  CHANNEL_NOT_AVAILABLE: 'CHANNEL_NOT_AVAILABLE',
  ALERT_RULE_INVALID: 'ALERT_RULE_INVALID',

  // --- sync / realtime (TZ §12, §13) --------------------------------------
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_CURSOR_INVALID: 'SYNC_CURSOR_INVALID',
  RESUME_WINDOW_EXPIRED: 'RESUME_WINDOW_EXPIRED',
  /** §13.4 — batch over 500 changes or 1 MB. */
  SYNC_BATCH_TOO_LARGE: 'SYNC_BATCH_TOO_LARGE',
  /** §13.4 — a change `type` the server does not recognise (client is ahead of the server). */
  SYNC_UNKNOWN_CHANGE_TYPE: 'SYNC_UNKNOWN_CHANGE_TYPE',
  /** MR-25 — a sync change names another `driverId` that did not share a co-driver pairing
   * (same unit) with the caller at `occurredAt`, or a change type that cannot be delegated. */
  SYNC_DELEGATION_NOT_ALLOWED: 'SYNC_DELEGATION_NOT_ALLOWED',

  // --- reports (TZ §15) -----------------------------------------------------
  REPORT_NOT_FOUND: 'REPORT_NOT_FOUND',
  REPORT_NOT_READY: 'REPORT_NOT_READY',
  REPORT_SCHEDULE_NOT_FOUND: 'REPORT_SCHEDULE_NOT_FOUND',
  INVALID_CRON_EXPRESSION: 'INVALID_CRON_EXPRESSION',

  // --- storage / integrations (TZ §16, §17) -------------------------------
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  /** B-51 — `POST /me/avatar` requires PNG/JPG >= 256x256. */
  IMAGE_TOO_SMALL: 'IMAGE_TOO_SMALL',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  WEBHOOK_DELIVERY_FAILED: 'WEBHOOK_DELIVERY_FAILED',
  INTEGRATION_NOT_CONFIGURED: 'INTEGRATION_NOT_CONFIGURED',
  /** §20 B-41 — `GET /attachments/:id/presign`: no `Attachment` row with that id. */
  ATTACHMENT_NOT_FOUND: 'ATTACHMENT_NOT_FOUND',

  // --- trips / dispatch (mobile/tz.md §21.1 MB-5) -------------------------
  TRIP_NOT_FOUND: 'TRIP_NOT_FOUND',
  /** MR-2 — `POST /mobile/release-vehicle` while the driver holds no unit (409). */
  NO_ASSIGNED_VEHICLE: 'NO_ASSIGNED_VEHICLE',
  /** MR-22 — `POST /mobile/co-driver/switch` with a wrong co-driver password (422, never 401:
   * the caller's own session is valid, so a 401 would make the app drop its token). */
  CO_DRIVER_PASSWORD_INVALID: 'CO_DRIVER_PASSWORD_INVALID',
  /** `PATCH /mobile/trip { trailerNumber }` — no live `Trailer` row with that number exists.
   * Deliberately rejected rather than stored as free text (no schema change, TZ §5.3).
   * Also 422 on `POST /trips`, `POST /trips/:id/assign` and `POST /mobile/dvir` when `trailerId`
   * is unknown or names a soft-deleted trailer. */
  TRAILER_NOT_FOUND: 'TRAILER_NOT_FOUND',
  /** §20 B-73 — `POST /trips/:id/publish` (or `PATCH` to a non-DRAFT status) on a trip that is
   * not currently DRAFT. */
  TRIP_NOT_DRAFT: 'TRIP_NOT_DRAFT',
  /** 409 on the web-panel `POST /trips`, `PATCH /trips/:id` and `POST /trips/:id/assign`: the
   * unit (`vehicleId`) already has another live trip whose time range overlaps this one.
   * `details.vehicleId` is the message, `details.conflict` names the other trip. */
  TRIP_SCHEDULE_CONFLICT: 'TRIP_SCHEDULE_CONFLICT',
  /** 409 on the web-panel `DELETE /trips/:id`: the trip is IN_PROGRESS (the driver is actively
   * running it on mobile) and cannot be deleted. Cancel/finish it first. */
  TRIP_IN_PROGRESS: 'TRIP_IN_PROGRESS',
  /** 409 on the web-panel `PATCH /trips/:id`: non-status fields cannot be edited once the trip is
   * DELIVERED or CANCELLED. */
  TRIP_NOT_EDITABLE: 'TRIP_NOT_EDITABLE',

  // --- geofences (TZ §20 B-93) ----------------------------------------------
  /** `GEOCODER_URL` is unset — `type: 'ADDRESS'` cannot be resolved to coordinates. */
  GEOCODER_NOT_CONFIGURED: 'GEOCODER_NOT_CONFIGURED',
  /** The configured geocoder returned zero matches (or failed) for the given `address`. */
  GEOCODE_FAILED: 'GEOCODE_FAILED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
