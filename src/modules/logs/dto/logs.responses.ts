import { ApiProperty } from '@nestjs/swagger';
import { DutyStatus, EditorType, ViolationStatus, ViolationType } from '@prisma/client';

/**
 * Swagger response classes for the driver's RODS routes (`GET /mobile/logs`, the bootstrap
 * inspection packet, `POST /mobile/log-entries` / `duty-status`, `POST /mobile/certify`,
 * `GET /mobile/log-edit-requests`, `GET /mobile/certification-status`) — D-131. Documentation
 * only: the shapes mirror `LogsService` (`buildDays`, `toEventView`, `createLogEntry`,
 * `certifyDays`, `toEditRequestView`, `getCertificationStatus`); nothing validates against them.
 */
const DT = { type: String, format: 'date-time' } as const;
const DAY = { type: String, format: 'date', example: '2026-10-08' } as const;
const INT = { type: 'integer' } as const;
export const SPECIAL_CONDITIONS = ['NONE', 'PC', 'YM'] as const;

export class LogDaySummaryView {
  @ApiProperty(DAY) date!: string;
  @ApiProperty({ type: String, example: 'America/Chicago' }) timezone!: string;
  @ApiProperty(INT) offDutySec!: number;
  @ApiProperty(INT) sleeperSec!: number;
  @ApiProperty(INT) drivingSec!: number;
  @ApiProperty(INT) onDutySec!: number;
  @ApiProperty(INT) totalDistanceMi!: number;
  @ApiProperty({ ...INT, description: '82800 / 86400 / 90000 — the DST-correct day length (§23).' }) dayLengthSec!: number;
  @ApiProperty({ type: Boolean }) certified!: boolean;
  @ApiProperty({ ...DT, nullable: true }) certifiedAt!: string | null;
  @ApiProperty(INT) certificationCount!: number;
  @ApiProperty({ type: Boolean }) hasViolation!: boolean;
  @ApiProperty(INT) violationCount!: number;
  @ApiProperty({ type: Boolean }) hasUnassigned!: boolean;
  @ApiProperty({ type: Boolean }) hasEdits!: boolean;
}

export class LogGraphSegmentView {
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus', description: 'The recorded duty status.' }) status!: DutyStatus;
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus', description: 'What the segment counts as: PC => OFF, YM => ON.' }) effective!: DutyStatus;
  @ApiProperty({ enum: SPECIAL_CONDITIONS, enumName: 'SpecialCondition' }) special!: (typeof SPECIAL_CONDITIONS)[number];
  @ApiProperty(DT) startAt!: string;
  @ApiProperty(DT) endAt!: string;
  @ApiProperty(INT) durationSec!: number;
  @ApiProperty({ type: String, nullable: true, description: 'MR-13 — id of the record that opened this status.' }) eventId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '§395 App. A 7.29 location text (stored, else offline geo-location).' }) locationDescription!: string | null;
  @ApiProperty({ ...INT, nullable: true }) odometerMi!: number | null;
  @ApiProperty({ type: Number, nullable: true }) engineHours!: number | null;
  @ApiProperty({ type: String, nullable: true }) annotation!: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'MB-14 — true only for the segment that opens the day (starts at 00:00 home-terminal time) when the status in force ' +
      'was recorded on an EARLIER RODS day; `eventId` then points at that earlier record, which is NOT repeated in this ' +
      'day\'s `events[]` (it belongs to the previous day). false whenever the opening record lies inside the day.',
  })
  carriedOver!: boolean;
}

export class LogEventView {
  @ApiProperty({ type: String, description: 'EldEvent id (bigint as a string).' }) id!: string;
  @ApiProperty(INT) eventType!: number;
  @ApiProperty(INT) eventCode!: number;
  @ApiProperty(INT) eventSequenceId!: number;
  @ApiProperty(DT) eventDateTime!: string;
  @ApiProperty({ ...INT, description: '1 active, 2 inactive-changed, 3 inactive-change requested, 4 inactive-change rejected.' }) recordStatus!: number;
  @ApiProperty({ ...INT, description: '1 ELD, 2 driver, 3 other user, 4 unidentified driver profile.' }) recordOrigin!: number;
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus', nullable: true, description: 'Only for eventType 1.' }) status!: DutyStatus | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty({ ...INT, nullable: true }) totalVehicleMiles!: number | null;
  @ApiProperty({ type: Number, nullable: true }) totalEngineHours!: number | null;
  @ApiProperty({ type: String, nullable: true }) annotation!: string | null;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiProperty({ type: String, nullable: true }) supersedesId!: string | null;
  @ApiProperty({ type: String, nullable: true }) editedById!: string | null;
  @ApiProperty({ enum: EditorType, enumName: 'EditorType', nullable: true }) editorType!: EditorType | null;
  @ApiProperty({ type: String, nullable: true }) editReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) vehicleId!: string | null;
  @ApiProperty({ type: String, description: 'MR-13 alias of `id`.' }) eventId!: string;
  @ApiProperty({ type: String, nullable: true }) locationDescription!: string | null;
  @ApiProperty({ ...INT, nullable: true, description: 'MR-13 alias of `totalVehicleMiles`.' }) odometerMi!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'MR-13 alias of `totalEngineHours`.' }) engineHours!: number | null;
  @ApiProperty({ enum: SPECIAL_CONDITIONS, enumName: 'SpecialCondition', nullable: true, description: 'Only for eventType 3.' }) specialCondition!: (typeof SPECIAL_CONDITIONS)[number] | null;
  @ApiProperty({ type: String, nullable: true }) malfunctionCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) diagnosticCode!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['REPLACED_DEVICE'],
    description:
      'D-163 — set when a replaced device (single-device rule) delivered this record late: recorded after that device was signed out by another login and before the driver signed in on it again. Driver-entered duty / PC-YM records so flagged are stored with recordStatus 3 and change no graph / HOS until a fleet manager re-enters them via the §395.30 edit flow; ELD-automatic records (PT30 driving) stay active and are only labelled.',
  })
  reviewReason!: 'REPLACED_DEVICE' | null;
  @ApiProperty({ type: String, nullable: true, description: 'D-163 — label of the replaced device the record came from (e.g. "Pixel 7").' })
  reviewDeviceLabel!: string | null;
}

export class LogDayTripView {
  @ApiProperty({ type: [String] }) shippingDocuments!: string[];
  @ApiProperty({ type: [String] }) trailerNumbers!: string[];
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: Boolean }) bobtail!: boolean;
  @ApiProperty({ type: [String] }) tripIds!: string[];
  @ApiProperty({ type: [String] }) tripNumbers!: string[];
  @ApiProperty({ type: Boolean, description: 'D-129 — a no-trip day-details row exists for the day.' }) dayDetails!: boolean;
}

export class LogViolationView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: String, nullable: true }) dailyLogId!: string | null;
  @ApiProperty({ ...DT, description: 'RODS day at UTC midnight (a `@db.Date` column).' }) logDate!: string;
  @ApiProperty({ enum: ViolationType, enumName: 'ViolationType' }) type!: ViolationType;
  @ApiProperty(DT) occurredAt!: string;
  @ApiProperty(INT) exceededBySec!: number;
  @ApiProperty({ type: String }) detail!: string;
  @ApiProperty({ enum: ViolationStatus, enumName: 'ViolationStatus' }) status!: ViolationStatus;
  @ApiProperty(INT) recalcVersion!: number;
  @ApiProperty({ ...DT, nullable: true }) resolvedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolvedById!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolutionNote!: string | null;
}

export class LogDayCertificationView {
  @ApiProperty({ type: Boolean }) certified!: boolean;
  @ApiProperty({ ...DT, nullable: true }) certifiedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) certifiedById!: string | null;
  @ApiProperty({ enum: EditorType, enumName: 'EditorType', nullable: true }) certifierType!: EditorType | null;
  @ApiProperty(INT) certificationCount!: number;
  @ApiProperty({ type: String, nullable: true }) signatureUrl!: string | null;
  @ApiProperty({ type: Boolean, description: '§9.2 — was certified and changed afterwards.' }) recertificationRequired!: boolean;
}

/** One full RODS day — `GET /mobile/logs` and every `bootstrap.inspectionPacket.days[]` entry. */
export class LogDayResponse {
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty(DAY) date!: string;
  @ApiProperty({ type: String, example: 'America/Chicago' }) timezone!: string;
  @ApiProperty({ type: () => LogDaySummaryView }) summary!: LogDaySummaryView;
  @ApiProperty({ type: () => LogGraphSegmentView, isArray: true }) graph!: LogGraphSegmentView[];
  @ApiProperty({
    type: () => LogEventView,
    isArray: true,
    description:
      'MB-14 — every §395 record with `eventDateTime` in [day start, next day start) (home-terminal zone), oldest first: ' +
      'all event types, every duty-status (eventType 1) record of the day, all record statuses (1 active, 2 inactive-changed, ' +
      '3 change requested, 4 change rejected) and all origins (1 ELD, 2 driver, 3 carrier, 4 unidentified/assumed). ' +
      'The status carried over from the previous day is not repeated — see `graph[].carriedOver`.',
  })
  events!: LogEventView[];
  @ApiProperty({ type: () => LogDayTripView, description: 'MR-12 / D-129.' }) trip!: LogDayTripView;
  @ApiProperty({ type: Boolean, description: 'MR-16 — an Appendix A malfunction was in force at some instant of the day.' }) malfunctionIndicator!: boolean;
  @ApiProperty({ type: Boolean, description: 'MR-16 — a data diagnostic event was in force at some instant of the day.' }) diagnosticIndicator!: boolean;
  @ApiProperty({ type: () => LogViolationView, isArray: true }) violations!: LogViolationView[];
  @ApiProperty({ type: () => LogDayCertificationView }) certification!: LogDayCertificationView;
}

/** §13.5 — the last 8 RODS days, cached by the app for an offline DOT inspection. */
export class InspectionPacketView {
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: String }) timezone!: string;
  @ApiProperty(DT) generatedAt!: string;
  @ApiProperty({ type: () => LogDayResponse, isArray: true }) days!: LogDayResponse[];
}

/** `POST /mobile/log-entries`, `POST /mobile/duty-status` (and the sync `duty_status` / `log_entry` changes). */
export class LogEntryResultResponse {
  @ApiProperty({ type: String, description: 'The new EldEvent id (bigint as a string).' }) id!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus' }) status!: DutyStatus;
  @ApiProperty({ enum: SPECIAL_CONDITIONS, enumName: 'SpecialCondition' }) specialCondition!: (typeof SPECIAL_CONDITIONS)[number];
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty(DT) startAt!: string;
  @ApiProperty({ ...DT, nullable: true }) endAt!: string | null;
  @ApiProperty({ ...INT, enum: [2], description: 'Always 2 (driver).' }) recordOrigin!: 2;
  @ApiProperty({ ...INT, enum: [1], description: 'Always 1 (active).' }) recordStatus!: 1;
  @ApiProperty({ type: Boolean, enum: [true] }) applied!: true;
  @ApiProperty({ type: Boolean, enum: [true], description: 'The day must be certified again.' }) recertificationRequired!: true;
}

export class CertifiedDayView {
  @ApiProperty(DAY) date!: string;
  @ApiProperty({ type: Boolean, enum: [true] }) certified!: true;
  @ApiProperty(INT) certificationCount!: number;
  @ApiProperty({ ...INT, description: 'eventType 4 code: 1 = first certification, 2..9 = re-certification.' }) eventCode!: number;
  @ApiProperty({ ...DT, nullable: true }) certifiedAt!: string | null;
  @ApiProperty({ enum: EditorType, enumName: 'EditorType', nullable: true }) certifierType!: EditorType | null;
}

export class CertifyResponse {
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: () => CertifiedDayView, isArray: true }) days!: CertifiedDayView[];
}

/** MB-10 — the record an EDIT proposal replaces. */
export class EditRequestOriginalView {
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus', nullable: true }) status!: DutyStatus | null;
  @ApiProperty(DT) start!: string;
  @ApiProperty({ ...DT, nullable: true, description: 'Next active duty-status record; null while it is still in force.' }) end!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '§395 App. A 7.29 location text (stored, else offline geo-location).' }) location!: string | null;
}

/** MB-10 — one segment of `proposedGraph` (the `graph` segment core fields). */
export class EditRequestGraphSegmentView {
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus' }) status!: DutyStatus;
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus', description: 'PC => OFF, YM => ON.' }) effective!: DutyStatus;
  @ApiProperty({ enum: SPECIAL_CONDITIONS, enumName: 'SpecialCondition' }) special!: (typeof SPECIAL_CONDITIONS)[number];
  @ApiProperty(DT) startAt!: string;
  @ApiProperty(DT) endAt!: string;
  @ApiProperty(INT) durationSec!: number;
}

export class EditRequestRequesterView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Jane Dispatcher' }) name!: string | null;
}

/** MB-12 — `POST /logs/edit-requests/:id/accept|reject` (`data` of the envelope). */
export class EditRequestResolutionResponse {
  @ApiProperty({ type: String, description: 'The edit request id (EldEvent id, bigint as a string).' }) id!: string;
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'], enumName: 'EditRequestResolution' }) status!: 'ACCEPTED' | 'REJECTED';
  @ApiProperty({ type: Boolean, description: 'true on accept (the proposal is now the active record), false on reject (the log is unchanged).' }) applied!: boolean;
}

export class EditRequestView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ enum: ['PENDING', 'ACCEPTED', 'REJECTED'], enumName: 'EditRequestStatus' }) status!: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  @ApiProperty({ enum: ['EDIT', 'INSERT'], enumName: 'EditRequestKind', description: '`INSERT` proposes a new record; `EDIT` replaces `originalEventId`.' }) kind!: 'EDIT' | 'INSERT';
  @ApiProperty({ type: String, nullable: true }) originalEventId!: string | null;
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus', nullable: true }) proposedStatus!: DutyStatus | null;
  @ApiProperty({ enum: SPECIAL_CONDITIONS, enumName: 'SpecialCondition' }) proposedSpecial!: (typeof SPECIAL_CONDITIONS)[number];
  @ApiProperty(DT) proposedStart!: string;
  @ApiProperty({ ...DT, nullable: true }) proposedEnd!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty({ type: String, nullable: true }) annotation!: string | null;
  @ApiProperty({ type: String, nullable: true }) requestedById!: string | null;
  @ApiProperty(DT) requestedAt!: string;
  @ApiProperty({ ...DT, nullable: true }) resolvedAt!: string | null;
  @ApiProperty({ ...DAY, description: 'MB-10 — RODS day of `proposedStart` in the driver\'s home-terminal zone.' }) date!: string;
  @ApiProperty({ type: () => EditRequestOriginalView, nullable: true, description: 'MB-10 — the record the proposal replaces; null for an INSERT.' })
  original!: EditRequestOriginalView | null;
  @ApiProperty({
    type: () => EditRequestGraphSegmentView,
    isArray: true,
    description:
      'MB-10 — the `date` day graph as it would read if the driver accepted now: computed by the same plan ' +
      '`POST /logs/edit-requests/:id/accept` writes. Empty for a request that is no longer PENDING.',
  })
  proposedGraph!: EditRequestGraphSegmentView[];
  @ApiProperty({ type: () => EditRequestRequesterView, nullable: true, description: 'MB-10 — the carrier user who proposed the edit.' })
  requestedBy!: EditRequestRequesterView | null;
}

export class EditRequestListResponse {
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: () => EditRequestView, isArray: true }) items!: EditRequestView[];
}

export class CertificationStatusDayResponse {
  @ApiProperty(DAY) date!: string;
  @ApiProperty({ type: Boolean }) certified!: boolean;
  @ApiProperty({ ...DT, nullable: true }) certifiedAt!: string | null;
  @ApiProperty(INT) certificationCount!: number;
  @ApiProperty({ type: Boolean }) recertificationRequired!: boolean;
}
