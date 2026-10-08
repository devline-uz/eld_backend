import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppPlatform,
  BleState,
  ConversationType,
  DefectPart,
  DefectSeverity,
  DefectStatus,
  DeviceModel,
  DeviceStatus,
  DistanceUnit,
  DriverStatus,
  DutyStatus,
  DvirCondition,
  DvirType,
  ErodsMode,
  HosRuleset,
  MaintenanceScheduleStatus,
  RepairStatus,
  StopStatus,
  StopType,
  TripStatus,
  VehicleStatus,
} from '@prisma/client';
import { ServerHosStateView } from '../../hos-state/dto/hos-state.responses';
import { InspectionPacketView } from '../../logs/dto/logs.responses';

/**
 * Swagger response classes for the `/mobile/*` routes of this module (mobile request #13, D-131).
 * Documentation only — every class mirrors what the service really returns (read the service
 * named in each class comment before changing one). `nullable: true` = the key is always present
 * and may be `null`; `@ApiPropertyOptional` = the key may be absent.
 */
const DT = { type: String, format: 'date-time' } as const;
const DAY = { type: String, format: 'date', example: '2026-10-08' } as const;
const INT = { type: 'integer' } as const;

// ---------------------------------------------------------------- app config / legal (MobileAppConfigService)

export class MobileAppConfigResponse {
  @ApiProperty({ type: String, nullable: true, example: '1.0.0' }) minSupportedVersion!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '1.0.3' }) latestVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) storeUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) userManualUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) privacyPolicyUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) termsUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) minPt30Firmware!: string | null;
  @ApiProperty({ type: String, nullable: true }) recommendedPt30Firmware!: string | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Null unless `appVersion` was sent and a minimum is configured.' }) updateRequired!: boolean | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Null unless `appVersion` was sent and a latest version is configured.' }) updateAvailable!: boolean | null;
}

export class MobileLegalResponse {
  @ApiProperty({ type: String, nullable: true }) version!: string | null;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Always null today — open `url`.' }) html!: string | null;
}

// ---------------------------------------------------------------- catalog / saved signature

export class DefectCatalogItemResponse {
  @ApiProperty({ type: String, example: 'BRAKES_SERVICE', description: 'Send as `defects[].category` in `POST /mobile/dvir`.' }) code!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ enum: DefectPart, enumName: 'DefectPart' }) part!: DefectPart;
  @ApiProperty({ type: String, nullable: true }) category!: string | null;
  @ApiProperty({ type: Boolean }) critical!: boolean;
  @ApiProperty({ type: Boolean, description: 'M-29 — photo-capture row ("Accident Photo"), not an inspection item.' }) isPhoto!: boolean;
}

/** `MobileSavedSignatureService.toView`. */
export class SavedSignatureResponse {
  @ApiProperty({ type: String }) signatureImageId!: string;
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String, description: 'Presigned GET URL, valid 15 minutes.' }) url!: string;
  @ApiProperty({ type: String, enum: ['image/png', 'image/jpeg'] }) mimeType!: string;
  @ApiProperty(INT) sizeBytes!: number;
  @ApiProperty({ type: String }) sha256!: string;
  @ApiProperty(DT) updatedAt!: string;
}

export class DeletedResponse {
  @ApiProperty({ type: Boolean }) deleted!: boolean;
}

// ---------------------------------------------------------------- contacts (MobileContactsService)

export class MobileContactResponse {
  @ApiProperty({ type: String, description: 'User id, co-driver id, or the literal `support`.' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, example: 'DISPATCHER', description: 'Staff role key (SUPER_ADMIN | ADMIN | FLEET_MANAGER | DISPATCHER), `CO_DRIVER` or `SUPPORT`.' }) role!: string;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
}

// ---------------------------------------------------------------- signature + DVIR (MobileDvirService)

export class SignatureUploadResponse {
  @ApiProperty({ type: String }) signatureImageId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Set for purpose DVIR_PHOTO and INVOICE (the Attachment id), else null.' }) attachmentId!: string | null;
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) sha256!: string;
  @ApiProperty(INT) sizeBytes!: number;
}

export class DvirSubmitResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: String }) vehicleId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'D-129 — the linked carrier trailer.' }) trailerId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'D-129 — the trailer number as typed.' }) trailerNumber!: string | null;
  @ApiProperty({ enum: DvirType, enumName: 'DvirType' }) type!: DvirType;
  @ApiProperty(DT) submittedAt!: string;
  @ApiProperty({ enum: DvirCondition, enumName: 'DvirCondition' }) vehicleCondition!: DvirCondition;
  @ApiProperty(INT) defectCount!: number;
  @ApiProperty(INT) photoCount!: number;
  @ApiProperty({ type: Boolean }) outOfService!: boolean;
  @ApiProperty({ type: String }) signatureImageId!: string;
  @ApiProperty({ type: String, nullable: true }) mechanicSignatureImageId!: string | null;
  @ApiProperty({ type: Boolean, enum: [true] }) applied!: true;
}

// ---------------------------------------------------------------- vehicles (MobileVehicleService)

export class AvailableVehicleResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) unitNumber!: string;
  @ApiProperty({ type: String, nullable: true }) make!: string | null;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty({ type: String, nullable: true }) deviceSerial!: string | null;
}

export class ReleaseVehicleResponse {
  @ApiProperty({ type: Boolean, enum: [true] }) released!: true;
  @ApiProperty({ type: String }) vehicleId!: string;
}

export class VehicleDeviceView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) serial!: string;
  @ApiProperty({ enum: DeviceModel, enumName: 'DeviceModel' }) model!: DeviceModel;
}

export class SelectedVehicleResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) unitNumber!: string;
  @ApiProperty({ type: String }) vin!: string;
  @ApiProperty({ type: String, nullable: true }) make!: string | null;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty({ ...INT, nullable: true }) year!: number | null;
  @ApiProperty({ type: Boolean }) sleeperBerth!: boolean;
  @ApiProperty({ enum: VehicleStatus, enumName: 'VehicleStatus' }) status!: VehicleStatus;
  @ApiProperty(INT) odometerMi!: number;
  @ApiProperty({ type: () => VehicleDeviceView, nullable: true, description: 'MR-21 — the ELD bound to the unit.' }) device!: VehicleDeviceView | null;
}

// ---------------------------------------------------------------- device health / MAC

export class DeviceHealthDeviceView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) serial!: string;
  @ApiProperty({ type: String, nullable: true }) firmware!: string | null;
  @ApiProperty({ enum: BleState, enumName: 'BleState' }) bleState!: BleState;
  @ApiProperty(INT) storedEventsCount!: number;
  @ApiProperty({ ...DT, nullable: true }) lastDeviceStatusAt!: string | null;
}

export class DeviceHealthCodeView {
  @ApiProperty({ enum: ['malfunction', 'diagnostic'], enumName: 'DeviceHealthCodeKind' }) kind!: 'malfunction' | 'diagnostic';
  @ApiProperty({ type: String, example: 'P', description: 'Appendix A malfunction (letter) / data diagnostic (digit) code.' }) code!: string;
}

export class DeviceHealthUnidentifiedView {
  @ApiProperty(INT) windowDays!: number;
  @ApiProperty(INT) pendingCount!: number;
  @ApiProperty({ type: [String], description: 'Pending segment ids — answer with `POST /unidentified/:id/confirm`.' }) pendingConfirmationRequestIds!: string[];
}

export class DeviceHealthHosDriftView {
  @ApiProperty(DT) computedAt!: string;
  @ApiProperty({ ...DT, nullable: true }) lastComparedAt!: string | null;
  @ApiProperty({ ...INT, nullable: true }) maxDriftSec!: number | null;
  @ApiProperty({ type: Boolean }) driftAlerted!: boolean;
}

export class DeviceHealthResponse {
  @ApiProperty({ type: String, nullable: true }) vehicleId!: string | null;
  @ApiProperty({ type: () => DeviceHealthDeviceView, nullable: true }) device!: DeviceHealthDeviceView | null;
  @ApiProperty({ type: () => DeviceHealthCodeView, isArray: true }) activeCodes!: DeviceHealthCodeView[];
  @ApiProperty({ type: () => DeviceHealthUnidentifiedView }) unidentified!: DeviceHealthUnidentifiedView;
  @ApiProperty({ type: () => DeviceHealthHosDriftView, nullable: true }) hosDrift!: DeviceHealthHosDriftView | null;
}

export class DeviceMacReportResponse {
  @ApiProperty({ type: String }) deviceId!: string;
  @ApiProperty({ type: String, example: 'A4:C1:38:5E:A8:6E', description: 'Upper-case, colon-separated.' }) macAddress!: string;
  @ApiProperty({ enum: ['STORED', 'UNCHANGED'], enumName: 'DeviceMacOutcome' }) outcome!: 'STORED' | 'UNCHANGED';
}

// ---------------------------------------------------------------- co-driver (MobileCoDriverService)

export class CoDriverIdentityView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) firstName!: string;
  @ApiProperty({ type: String }) lastName!: string;
  @ApiProperty({ type: String }) username!: string;
}

export class TripListsView {
  @ApiProperty({ type: [String] }) shippingDocuments!: string[];
  @ApiProperty({ type: [String] }) trailerNumbers!: string[];
}

export class CoDriverPairingResponse {
  @ApiProperty({ type: String }) pairingId!: string;
  @ApiProperty(DT) startedAt!: string;
  @ApiProperty({ type: () => CoDriverIdentityView }) coDriver!: CoDriverIdentityView;
  @ApiPropertyOptional({ type: () => TripListsView, description: 'Absent (not null) when the caller has no active trip.' }) trip?: TripListsView;
}

export class CoDriverLeaveResponse {
  @ApiProperty({ type: Boolean, description: 'False when there was no active pairing (the unit is then NOT released).' }) ended!: boolean;
}

// ---------------------------------------------------------------- bootstrap (MobileBootstrapService)

export class BootstrapDriverExceptionsView {
  @ApiProperty({ type: Boolean }) allowPersonalConveyance!: boolean;
  @ApiProperty({ type: Boolean }) allowYardMove!: boolean;
  @ApiProperty({ type: Boolean }) adverseDrivingEnabled!: boolean;
  @ApiProperty({ type: Boolean }) shortHaulException!: boolean;
  @ApiProperty({ type: Boolean }) splitSleeperEnabled!: boolean;
  @ApiProperty({ type: Boolean }) eldExempt!: boolean;
  @ApiProperty({ type: String, nullable: true }) eldExemptReason!: string | null;
}

export class BootstrapDriverView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, example: 'johnsmith', description: 'M-31 — the ELD username (Appendix A 7.38).' }) username!: string;
  @ApiProperty({ type: String }) firstName!: string;
  @ApiProperty({ type: String }) lastName!: string;
  @ApiProperty({ type: String }) cdlNumber!: string;
  @ApiProperty({ type: String }) cdlState!: string;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: Boolean, description: 'MR-16 — §395.1 exempt driver status.' }) exemptDriverStatus!: boolean;
  @ApiProperty({ enum: DriverStatus, enumName: 'DriverStatus' }) status!: DriverStatus;
  @ApiProperty({ type: String }) homeTerminalName!: string;
  @ApiProperty({ type: String, example: 'America/Chicago' }) homeTerminalTimezone!: string;
  @ApiProperty({ enum: HosRuleset, enumName: 'HosRuleset' }) hosRuleset!: HosRuleset;
  @ApiProperty({ type: () => BootstrapDriverExceptionsView }) exceptions!: BootstrapDriverExceptionsView;
  @ApiProperty({ ...DT, nullable: true }) lastSyncAt!: string | null;
}

export class BootstrapVehicleView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) unitNumber!: string;
  @ApiProperty({ type: String }) vin!: string;
  @ApiProperty({ type: String, nullable: true }) make!: string | null;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty({ ...INT, nullable: true }) year!: number | null;
  @ApiProperty({ type: Boolean }) sleeperBerth!: boolean;
  @ApiProperty({ enum: VehicleStatus, enumName: 'VehicleStatus' }) status!: VehicleStatus;
  @ApiProperty(INT) odometerMi!: number;
}

export class BootstrapDeviceView {
  @ApiProperty({ type: String, description: 'Send as `deviceId` to `POST /mobile/device/mac`.' }) id!: string;
  @ApiProperty({ type: String }) serial!: string;
  @ApiProperty({ enum: DeviceModel, enumName: 'DeviceModel' }) model!: DeviceModel;
  @ApiProperty({ type: String, nullable: true }) firmware!: string | null;
  @ApiProperty({ enum: DeviceStatus, enumName: 'DeviceStatus' }) status!: DeviceStatus;
  @ApiProperty({ enum: BleState, enumName: 'BleState' }) bleState!: BleState;
  @ApiProperty({ type: String, nullable: true }) bleMacAddress!: string | null;
  @ApiProperty({ ...DT, nullable: true }) pairedAt!: string | null;
  @ApiProperty(INT) periodicConnectedSec!: number;
  @ApiProperty(INT) periodicDisconnectedMin!: number;
}

export class BootstrapCoDriverView {
  @ApiProperty({ type: String }) pairingId!: string;
  @ApiProperty({ type: String }) primaryDriverId!: string;
  @ApiProperty({ type: String }) coDriverId!: string;
  @ApiProperty(DT) startedAt!: string;
  @ApiProperty({ type: String }) firstName!: string;
  @ApiProperty({ type: String }) lastName!: string;
  @ApiProperty({ type: String }) username!: string;
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus', nullable: true, description: 'Latest active duty status of the co-driver.' }) currentStatus!: DutyStatus | null;
}

export class BootstrapCarrierView {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) dotNumber!: string;
  @ApiProperty({ type: String }) timezone!: string;
  @ApiProperty({ enum: HosRuleset, enumName: 'HosRuleset' }) hosRuleset!: HosRuleset;
  @ApiProperty({ enum: DistanceUnit, enumName: 'DistanceUnit' }) distanceUnit!: DistanceUnit;
  @ApiProperty({ type: Boolean }) allowPersonalConveyance!: boolean;
  @ApiProperty({ type: Boolean }) allowYardMove!: boolean;
  @ApiProperty({ type: String, minLength: 6, maxLength: 6, example: 'OBK001', description: 'D-121 — the 6-character ELD identifier (Appendix A 7.15).' }) eldIdentifier!: string;
  @ApiProperty({ type: String, nullable: true, description: 'MR-16 — "street, city, ST zip".' }) mainOfficeAddress!: string | null;
  @ApiProperty({ type: String, example: 'OneBook ELD' }) eldProvider!: string;
  @ApiProperty({ type: String, nullable: true, maxLength: 4 }) eldRegistrationId!: string | null;
  @ApiProperty({ enum: ErodsMode, enumName: 'ErodsMode' }) erodsMode!: ErodsMode;
}

export class BootstrapHosView {
  @ApiProperty(DT) computedAt!: string;
  @ApiProperty({ type: String }) timezone!: string;
  @ApiProperty({ type: () => ServerHosStateView }) state!: ServerHosStateView;
}

export class SyncConfigView {
  @ApiProperty({ ...INT, example: 500 }) batchMaxChanges!: number;
  @ApiProperty({ ...INT, example: 1048576 }) batchMaxBytes!: number;
  @ApiProperty({ ...INT, example: 60 }) onlineIntervalSec!: number;
  @ApiProperty({ ...INT, example: 50 }) onlineBatchThreshold!: number;
  @ApiProperty({ type: 'array', items: { type: 'integer' }, example: [30, 60, 300, 900, 1800] }) offlineBackoffSec!: number[];
  @ApiProperty({ ...INT, example: 30 }) localEventRetentionDays!: number;
  @ApiProperty({ ...INT, example: 8 }) localInspectionRetentionDays!: number;
  @ApiProperty({ ...INT, example: 30 }) syncBacklogWarnDays!: number;
  @ApiProperty({ ...INT, example: 209715200 }) syncBacklogWarnBytes!: number;
}

export class AppUpdateStoreUrlView {
  @ApiProperty({ type: String, nullable: true }) ios!: string | null;
  @ApiProperty({ type: String, nullable: true }) android!: string | null;
}

export class AppUpdateView {
  @ApiProperty({ type: String, nullable: true }) latestVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) minVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: () => AppUpdateStoreUrlView }) storeUrl!: AppUpdateStoreUrlView;
}

export class MobileBootstrapResponse {
  @ApiProperty(DT) serverTime!: string;
  @ApiProperty({ type: String, example: '1.0.3' }) hosEngineVersion!: string;
  @ApiProperty({ type: () => BootstrapDriverView }) driver!: BootstrapDriverView;
  @ApiProperty({ type: () => BootstrapVehicleView, nullable: true }) vehicle!: BootstrapVehicleView | null;
  @ApiProperty({ type: () => BootstrapDeviceView, nullable: true }) device!: BootstrapDeviceView | null;
  @ApiProperty({ type: () => BootstrapCoDriverView, nullable: true }) coDriver!: BootstrapCoDriverView | null;
  @ApiProperty({ type: () => AvailableVehicleResponse, isArray: true }) availableVehicles!: AvailableVehicleResponse[];
  @ApiProperty({ type: () => BootstrapCarrierView, nullable: true }) carrier!: BootstrapCarrierView | null;
  @ApiProperty({ type: () => BootstrapHosView, nullable: true }) hos!: BootstrapHosView | null;
  @ApiProperty({ type: () => InspectionPacketView, description: '§13.5 — the last 8 RODS days, same day shape as `GET /mobile/logs`.' }) inspectionPacket!: InspectionPacketView;
  @ApiProperty({ type: () => SyncConfigView }) syncConfig!: SyncConfigView;
  @ApiProperty({ type: () => AppUpdateView, nullable: true, description: 'MB-19 — null when no version is configured.' }) appUpdate!: AppUpdateView | null;
}

// ---------------------------------------------------------------- trip (MobileTripService)

export class MobileTripStopView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty(INT) sequence!: number;
  @ApiProperty({ enum: StopType, enumName: 'StopType' }) type!: StopType;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: Number, nullable: true }) latitude!: number | null;
  @ApiProperty({ type: Number, nullable: true }) longitude!: number | null;
  @ApiProperty({ ...DT, nullable: true }) scheduledAt!: string | null;
  @ApiProperty({ ...DT, nullable: true }) arrivedAt!: string | null;
  @ApiProperty({ ...DT, nullable: true }) departedAt!: string | null;
  @ApiProperty({ enum: StopStatus, enumName: 'StopStatus' }) status!: StopStatus;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class MobileTripDocumentView {
  @ApiProperty({ type: String }) tripId!: string;
  @ApiProperty({ type: String }) number!: string;
  @ApiProperty({ type: String, nullable: true }) shippingDocument!: string | null;
  @ApiProperty({ type: String, nullable: true }) commodity!: string | null;
  @ApiProperty({ ...INT, nullable: true }) pieces!: number | null;
  @ApiProperty({ ...INT, nullable: true }) weightLbs!: number | null;
}

/** `source: "TRIP"` — the active (IN_PROGRESS, else next ASSIGNED) trip. */
export class MobileActiveTripResponse {
  @ApiProperty({ type: String, enum: ['TRIP'] }) source!: 'TRIP';
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) number!: string;
  @ApiProperty({ enum: TripStatus, enumName: 'TripStatus' }) status!: TripStatus;
  @ApiProperty({ type: String, nullable: true }) vehicleId!: string | null;
  @ApiProperty({ type: String, nullable: true }) trailerId!: string | null;
  @ApiProperty({ type: String, nullable: true }) shippingDocument!: string | null;
  @ApiProperty({ type: [String] }) shippingDocuments!: string[];
  @ApiProperty({ type: String, nullable: true, description: 'First of `trailerNumbers`.' }) trailerNumber!: string | null;
  @ApiProperty({ type: [String] }) trailerNumbers!: string[];
  @ApiProperty({ type: Boolean }) bobtail!: boolean;
  @ApiProperty({ type: String, nullable: true }) commodity!: string | null;
  @ApiProperty({ ...INT, nullable: true }) weightLbs!: number | null;
  @ApiProperty({ ...INT, nullable: true }) pieces!: number | null;
  @ApiProperty({ ...DT, nullable: true }) plannedStartAt!: string | null;
  @ApiProperty({ ...DT, nullable: true }) plannedEndAt!: string | null;
  @ApiProperty({ ...DT, nullable: true }) startedAt!: string | null;
  @ApiProperty({ ...DT, nullable: true }) completedAt!: string | null;
  @ApiProperty({ ...DT, nullable: true }) etaAt!: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) onTime!: boolean | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: () => MobileTripStopView, isArray: true }) stops!: MobileTripStopView[];
  @ApiProperty({ type: () => MobileTripDocumentView, isArray: true, description: "Every non-completed trip of the driver (BOL summary)." }) documents!: MobileTripDocumentView[];
}

/** `source: "DAY_DETAILS"` — no active trip: the driver's day details for `logDate` (D-129). */
export class MobileDayDetailsResponse {
  @ApiProperty({ type: String, enum: ['DAY_DETAILS'] }) source!: 'DAY_DETAILS';
  @ApiProperty({ type: String, nullable: true, description: 'Always null.' }) id!: null;
  @ApiProperty({ type: 'object', properties: {}, nullable: true, description: 'Always null.' }) trip!: null;
  @ApiProperty({ ...DAY, description: 'Home-terminal RODS day.' }) logDate!: string;
  @ApiProperty({ type: String, nullable: true }) shippingDocument!: string | null;
  @ApiProperty({ type: [String] }) shippingDocuments!: string[];
  @ApiProperty({ type: String, nullable: true }) trailerId!: string | null;
  @ApiProperty({ type: String, nullable: true }) trailerNumber!: string | null;
  @ApiProperty({ type: [String] }) trailerNumbers!: string[];
  @ApiProperty({ type: Boolean }) bobtail!: boolean;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ ...DT, nullable: true, description: 'Null when nothing is stored for the day.' }) updatedAt!: string | null;
  @ApiProperty({ type: () => MobileTripStopView, isArray: true, description: 'Always empty.' }) stops!: MobileTripStopView[];
  @ApiProperty({ type: () => MobileTripDocumentView, isArray: true }) documents!: MobileTripDocumentView[];
}

export class TrailerOptionResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) number!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Always null today (no plate column).' }) plate!: string | null;
}

// ---------------------------------------------------------------- DVIR history (MobileDvirHistoryService)

export class DvirSummaryResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) vehicleId!: string;
  @ApiProperty({ enum: DvirType, enumName: 'DvirType' }) type!: DvirType;
  @ApiProperty(DT) submittedAt!: string;
  @ApiProperty({ enum: DvirCondition, enumName: 'DvirCondition' }) vehicleCondition!: DvirCondition;
  @ApiProperty(INT) defectCount!: number;
  @ApiProperty({ enum: RepairStatus, enumName: 'RepairStatus' }) repairStatus!: RepairStatus;
  @ApiProperty({ type: String, nullable: true, description: 'MR-14.' }) trailerNumber!: string | null;
  @ApiProperty({ ...INT, nullable: true, description: 'MR-14.' }) odometerMi!: number | null;
}

export class DvirPhotoView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, description: 'Presigned GET URL, valid 15 minutes.' }) url!: string;
  @ApiProperty({ type: String }) mimeType!: string;
  @ApiProperty(INT) sizeBytes!: number;
}

export class DvirDefectView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ enum: DefectPart, enumName: 'DefectPart' }) part!: DefectPart;
  @ApiProperty({ type: String, description: 'Catalog `code` (or the free text an older app sent).' }) category!: string;
  @ApiProperty({ enum: DefectSeverity, enumName: 'DefectSeverity' }) severity!: DefectSeverity;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ enum: DefectStatus, enumName: 'DefectStatus' }) status!: DefectStatus;
  @ApiProperty({ type: Boolean }) outOfService!: boolean;
  @ApiProperty({ ...DT, nullable: true }) resolvedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolutionNote!: string | null;
  @ApiProperty({ type: () => DvirPhotoView, isArray: true }) photos!: DvirPhotoView[];
}

export class DvirLocationView {
  @ApiProperty({ type: Number, nullable: true }) lat!: number | null;
  @ApiProperty({ type: Number, nullable: true }) lon!: number | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class DvirDriverSignatureView {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Presigned GET URL, valid 15 minutes.' }) url!: string | null;
  @ApiProperty({ type: String, nullable: true }) hash!: string | null;
}

export class DvirMechanicSignatureView {
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty(DT) signedAt!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true }) key!: string | null;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: String, nullable: true }) hash!: string | null;
}

export class DvirDetailResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: String }) vehicleId!: string;
  @ApiProperty({ type: String, nullable: true }) trailerId!: string | null;
  @ApiProperty({ enum: DvirType, enumName: 'DvirType' }) type!: DvirType;
  @ApiProperty(DT) submittedAt!: string;
  @ApiProperty({ ...INT, nullable: true }) odometerMi!: number | null;
  @ApiProperty({ type: () => DvirLocationView, nullable: true, description: 'MR-14 — null when neither a position nor a place name was captured.' }) location!: DvirLocationView | null;
  @ApiProperty({ type: String, nullable: true }) trailerNumber!: string | null;
  @ApiProperty({ enum: DvirCondition, enumName: 'DvirCondition' }) vehicleCondition!: DvirCondition;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ enum: RepairStatus, enumName: 'RepairStatus' }) repairStatus!: RepairStatus;
  @ApiProperty({ type: () => DvirDriverSignatureView }) driverSignature!: DvirDriverSignatureView;
  @ApiProperty({ type: () => DvirMechanicSignatureView, nullable: true }) mechanicSignature!: DvirMechanicSignatureView | null;
  @ApiProperty({ ...DT, nullable: true }) nextDriverReviewedAt!: string | null;
  @ApiProperty({ type: () => DvirDefectView, isArray: true }) defects!: DvirDefectView[];
  @ApiProperty({ type: () => DvirPhotoView, isArray: true, description: 'DVIR-level photos (not tied to a defect).' }) photos!: DvirPhotoView[];
}

// ---------------------------------------------------------------- push tokens (PushTokensRepository.upsert)

export class PushTokenResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: String }) token!: string;
  @ApiProperty({ enum: AppPlatform, enumName: 'AppPlatform' }) platform!: AppPlatform;
  @ApiProperty({ type: String, nullable: true }) deviceLabel!: string | null;
  @ApiProperty(DT) lastSeenAt!: string;
  @ApiProperty(DT) createdAt!: string;
}

// ---------------------------------------------------------------- maintenance (MobileMaintenanceService)

export class MaintenanceItemResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, example: 'OIL_CHANGE', description: 'UPPER_SNAKE label (free text, max 40).' }) scheduleType!: string;
  @ApiProperty({ type: String }) scheduleName!: string;
  @ApiProperty({ ...INT, nullable: true }) frequencyMi!: number | null;
  @ApiProperty({ ...INT, nullable: true, description: 'Negative = overdue by that many miles; null = date-only interval.' }) remainingMi!: number | null;
  @ApiProperty({ enum: MaintenanceScheduleStatus, enumName: 'MaintenanceScheduleStatus' }) status!: MaintenanceScheduleStatus;
  @ApiProperty({ ...DT, nullable: true, description: 'Completion time (COMPLETED), else last submission, else due date.' }) at!: string | null;
}

export class MaintenanceInvoiceAttachmentView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, example: 'invoice-INV-2291.pdf' }) fileName!: string;
  @ApiProperty({ type: String, example: 'application/pdf' }) mimeType!: string;
}

export class MaintenanceDetailResponse extends MaintenanceItemResponse {
  @ApiProperty({ type: String, nullable: true }) invoiceNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) vendorName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) cost!: number | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: () => MaintenanceInvoiceAttachmentView, nullable: true }) invoiceAttachment!: MaintenanceInvoiceAttachmentView | null;
  @ApiProperty({ ...DT, nullable: true }) submittedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) reviewNote!: string | null;
}

// ---------------------------------------------------------------- sync (MobileSyncService)

export class SyncRejectedView {
  @ApiProperty({ type: String }) clientId!: string;
  @ApiProperty({ type: String, example: 'DRIVING_TIME_IMMUTABLE', description: 'Stable code from common/errors/codes.ts.' }) code!: string;
  @ApiPropertyOptional({ type: String }) message?: string;
}

export class SyncServerChangeView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty(INT) eventType!: number;
  @ApiProperty(INT) eventCode!: number;
  @ApiProperty(DT) eventDateTime!: string;
  @ApiProperty(INT) recordStatus!: number;
  @ApiProperty(INT) recordOrigin!: number;
  @ApiProperty({ type: String, nullable: true }) annotation!: string | null;
  @ApiProperty({ type: String, nullable: true }) supersedesId!: string | null;
}

export class SyncResponse {
  @ApiProperty({ type: [String], description: 'clientIds applied (or already applied).' }) accepted!: string[];
  @ApiProperty({ type: () => SyncRejectedView, isArray: true }) rejected!: SyncRejectedView[];
  @ApiProperty({ type: () => SyncServerChangeView, isArray: true, description: 'RODS records since `lastSyncAt`.' }) serverChanges!: SyncServerChangeView[];
  @ApiProperty(DT) serverTime!: string;
  @ApiProperty({ type: String, example: '1.0.3' }) hosEngineVersion!: string;
  @ApiProperty({ ...INT, example: 60 }) nextSyncAfterSec!: number;
}

// ---------------------------------------------------------------- messaging (MobileMessagingService)

export class MobileParticipantView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ enum: ['DRIVER', 'STAFF'], enumName: 'ParticipantType' }) type!: 'DRIVER' | 'STAFF';
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

/** `toMobileMessage` — the stored `Message` row plus the MR-18 sender fields. */
export class MobileMessageView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) conversationId!: string;
  @ApiProperty({ type: String, nullable: true }) senderUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) senderDriverId!: string | null;
  @ApiProperty({ type: String }) body!: string;
  @ApiProperty({ type: String, nullable: true }) attachmentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) clientId!: string | null;
  @ApiProperty(DT) sentAt!: string;
  @ApiProperty({ ...DT, nullable: true }) deliveredAt!: string | null;
  @ApiProperty({ ...DT, nullable: true }) readAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Null for SYSTEM messages.' }) senderId!: string | null;
  @ApiProperty({ enum: ['DRIVER', 'STAFF', 'SYSTEM'], enumName: 'MessageSenderType' }) senderType!: 'DRIVER' | 'STAFF' | 'SYSTEM';
  @ApiProperty({ type: String, nullable: true }) senderName!: string | null;
}

export class MobileConversationView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ enum: ConversationType, enumName: 'ConversationType' }) type!: ConversationType;
  @ApiProperty({ type: String, nullable: true, description: 'Stored title, else the other party names, "Support" for SUPPORT; null when there is no other participant.' }) title!: string | null;
  @ApiProperty({ ...DT, nullable: true }) lastMessageAt!: string | null;
  @ApiProperty({ type: () => MobileMessageView, nullable: true }) lastMessage!: MobileMessageView | null;
  @ApiProperty(INT) unreadCount!: number;
  @ApiProperty({ type: () => MobileParticipantView, isArray: true }) participants!: MobileParticipantView[];
}

export class MobileConversationListResponse {
  @ApiProperty({ type: () => MobileConversationView, isArray: true }) items!: MobileConversationView[];
}

export class StartConversationMessageView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) body!: string;
  @ApiProperty(DT) sentAt!: string;
  @ApiProperty({ type: String }) senderId!: string;
  @ApiProperty({ type: String, enum: ['DRIVER'] }) senderType!: 'DRIVER';
  @ApiProperty({ type: String, nullable: true }) clientId!: string | null;
}

export class StartConversationResponse {
  @ApiProperty({ type: String }) conversationId!: string;
  @ApiProperty({ type: () => StartConversationMessageView }) message!: StartConversationMessageView;
}

export class MobileMessagePageResponse {
  @ApiProperty({ type: () => MobileMessageView, isArray: true, description: 'Newest first.' }) items!: MobileMessageView[];
  @ApiProperty(INT) limit!: number;
}

export class MessagesMarkedResponse {
  @ApiProperty(INT) messagesMarked!: number;
}
