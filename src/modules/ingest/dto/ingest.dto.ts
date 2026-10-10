import { z } from 'zod';

/**
 * TZ §7.1–§7.7 — every ingest payload comes from the APP (driver JWT), never from the PT30:
 * the device has no SIM and no Wi-Fi (§3.1). `deviceSerial` and `vehicleId` are therefore
 * UNTRUSTED claims made by a mobile client and are verified server-side before anything is
 * attributed to a driver.
 *
 * Only SCHEMA violations produce `400`/`422` (§7.3). Bad checksums, clock drift and implausible
 * odometers are data-quality problems: the event is stored anyway and flagged.
 */

/** §7.3 rule 2 — hard batch ceiling. */
export const MAX_BATCH_EVENTS = 500;
/** §7.3 rule 2 — hard payload ceiling. */
export const MAX_BATCH_BYTES = 1024 * 1024;
/** Telemetry is downsampled by the app to 1 point/60 s (§7.5); the ceiling is generous. */
export const MAX_TELEMETRY_POINTS = 500;

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

/** One §395 Appendix A event exactly as the SDK hands it to the app. */
export const IngestEventDto = z.object({
  uuid: z.string().min(8).max(64),
  eventType: z.number().int().min(1).max(7),
  eventCode: z.number().int().min(0).max(9),
  eventDateTime: isoDateTime,
  timezoneOffset: z.number().int().min(-840).max(840),
  recordStatus: z.number().int().min(1).max(4).default(1),
  recordOrigin: z.number().int().min(1).max(4),
  wasStoredOnDevice: z.boolean().default(false),
  latitude: latitude.nullish(),
  longitude: longitude.nullish(),
  locationName: z.string().max(120).nullish(),
  locationSource: z.number().int().min(0).max(9).nullish(),
  distanceSinceLastValidCoords: z.number().int().min(0).nullish(),
  /** Metric, straight from the PT30 (§4.1). Converted in `common/units/` only. */
  rawDeviceOdometerKm: z.number().min(0).nullish(),
  totalEngineHours: z.number().min(0).nullish(),
  malfunctionCode: z.string().max(1).nullish(),
  diagnosticCode: z.string().max(1).nullish(),
  annotation: z.string().max(60).nullish(),
  comment: z.string().max(500).nullish(),
  /** §7.3 rule 4 — verified, never a rejection reason. */
  checksum: z.string().max(128).nullish(),
});
export type IngestEventDto = z.infer<typeof IngestEventDto>;

export const IngestEventsDto = z.object({
  deviceSerial: z.string().min(1).max(60),
  vehicleId: z.string().uuid(),
  sdkVersion: z.string().max(20).optional(),
  batch: z.array(IngestEventDto).min(1).max(MAX_BATCH_EVENTS),
});
export type IngestEventsDto = z.infer<typeof IngestEventsDto>;

/**
 * PT SDK 6.11 bus spellings -> our `BusType` enum. The SDK reports the bus as a bit value
 * (OBD-II = 1, J1708 = 2, J1939 = 4) or as a name the two platforms spell differently
 * (`OBDII`, `OBD2`, `OBD-II`, `J1939`). Anything unrecognised becomes `null` rather than a 400:
 * one odd label must not cost the whole telemetry batch (D-135).
 */
export type NormalisedBusType = 'J1939' | 'J1708' | 'OBD_II';
export function normaliseBusType(value: unknown): NormalisedBusType | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (value === 1) return 'OBD_II';
    if (value === 2) return 'J1708';
    if (value === 4) return 'J1939';
    return null;
  }
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase().replace(/[\s_-]/g, '');
  if (key === 'J1939' || key === '4') return 'J1939';
  if (key === 'J1708' || key === '2') return 'J1708';
  if (key === 'OBDII' || key === 'OBD2' || key === '1') return 'OBD_II';
  return null;
}

/** Accepts `J1939|J1708|OBD_II`, the SDK spellings and the numeric bus bits 1/2/4. */
export const BusTypeInput = z
  .union([z.string().max(12), z.number().int()])
  .nullish()
  .transform((value) => (value === undefined ? undefined : normaliseBusType(value)));

/** One fault from the SDK's bus-specific `DtcData` (6.11): J1939 SPN/FMI, J1708 SID/PID+FMI,
 * OBD-II `code`. */
export const DtcCodeDto = z.object({
  /** J1939 SPN; for J1708 the SID/PID number when `code` is not sent (see `isSid`). */
  spn: z.number().int().min(0).max(999999).nullish(),
  fmi: z.number().int().min(0).max(31).nullish(),
  /** OBD-II code (`P0301`) or a J1708 label (`SID 254` / `PID 84`). */
  code: z.string().trim().min(1).max(20).nullish(),
  /** SDK `OccurrenceCount` (J1939/J1708). */
  occurrence: z.number().int().min(0).max(255).nullish(),
  bus: BusTypeInput,
  /** J1939 SPN conversion method bit (`ConversionMethod`). */
  conversionMethod: z.number().int().min(0).max(1).nullish(),
  /** J1708 only — the number in `spn` is a SID (true) or a PID (false). */
  isSid: z.boolean().nullish(),
  /** J1708 `isActive`. */
  active: z.boolean().nullish(),
  source: z.string().max(40).nullish(),
  description: z.string().max(200).nullish(),
});
export type DtcCodeDto = z.infer<typeof DtcCodeDto>;

/** §5.6 — Virtual Dashboard point. All inputs metric; the DB stores imperial. Latitude and
 * longitude are optional since SDK 6.11: a VDB snapshot without a GPS lock still carries engine
 * data. A point with only one of the pair is stored without a position. */
export const TelemetryPointDto = z.object({
  time: isoDateTime,
  latitude: latitude.nullish(),
  longitude: longitude.nullish(),
  speedKmh: z.number().min(0).max(400).nullish(),
  headingDeg: z.number().int().min(0).max(359).nullish(),
  odometerKm: z.number().min(0).nullish(),
  engineHours: z.number().min(0).nullish(),
  idleHours: z.number().min(0).nullish(),
  ptoHours: z.number().min(0).nullish(),
  engineOn: z.boolean().nullish(),
  rpm: z.number().int().min(0).max(10000).nullish(),
  /** SDK 6.11 reports the gear as an int (0-31); older builds sent a label. Stored as text. */
  gear: z
    .union([z.number().int().min(-1).max(255), z.string().max(8)])
    .nullish()
    .transform((value) => (value === null || value === undefined ? value : String(value))),
  seatBelt: z.boolean().nullish(),
  /** SDK `engineLoad` is 0-250 % (J1939 SPN 92 range). */
  loadPct: z.number().int().min(0).max(250).nullish(),
  fuelPct: z.number().int().min(0).max(100).nullish(),
  fuelPct2: z.number().int().min(0).max(100).nullish(),
  defPct: z.number().int().min(0).max(100).nullish(),
  fuelRateLph: z.number().min(0).nullish(),
  fuelEconomyKmpl: z.number().min(0).nullish(),
  totalFuelUsedL: z.number().min(0).nullish(),
  totalFuelIdleL: z.number().min(0).nullish(),
  oilPressureKpa: z.number().min(0).nullish(),
  oilPct: z.number().int().min(0).max(100).nullish(),
  oilTempC: z.number().int().min(-60).max(250).nullish(),
  coolantPct: z.number().int().min(0).max(100).nullish(),
  coolantTempC: z.number().int().min(-60).max(250).nullish(),
  intakeTempC: z.number().int().min(-60).max(250).nullish(),
  ambientTempC: z.number().int().min(-60).max(100).nullish(),
  transmOilTempC: z.number().int().min(-60).max(250).nullish(),
  /** SDK 6.11 Virtual Dashboard additions (metric, stored as sent — the columns are metric). */
  intakePressureKpa: z.number().min(0).max(9999).nullish(),
  barometerKpa: z.number().min(0).max(999).nullish(),
  fuelTempC: z.number().int().min(-60).max(250).nullish(),
  intercoolerTempC: z.number().int().min(-60).max(250).nullish(),
  turboOilTempC: z.number().int().min(-60).max(250).nullish(),
  retarderPct: z.number().int().min(-125).max(125).nullish(),
  brakePedal: z.number().int().min(0).max(255).nullish(),
  odometerComputed: z.boolean().nullish(),
  engineHoursComputed: z.boolean().nullish(),
  gpsLocked: z.boolean().nullish(),
  gpsSatellites: z.number().int().min(0).max(99).nullish(),
  gpsDop: z.number().min(0).max(999).nullish(),
  gpsAgeSec: z.number().int().min(0).max(2_147_483_647).nullish(),
  /** VIN read by the device (PT30). Recorded on `Device.reportedVin`, never on the point. */
  vin: z.string().trim().max(20).nullish(),
  /** Malfunction indicator lamp, applied to the DTC rows of this point. */
  milOn: z.boolean().nullish(),
  /** SDK `dtcNo` — pending DTC count. */
  dtcCount: z.number().int().min(0).nullish(),
  /** §5.7 — optional per-code breakdown behind `dtcCount`; absent when the SDK only reports
   * the count. Persisted into `DiagnosticTroubleCode` (deduped per bus, see DtcService). */
  dtcCodes: z.array(DtcCodeDto).max(50).nullish(),
  busType: BusTypeInput,
  voltage: z.number().min(0).max(99).nullish(),
  /** The app never drops a transition point when downsampling (§7.5). */
  isTransition: z.boolean().default(false),
});
export type TelemetryPointDto = z.infer<typeof TelemetryPointDto>;

export const IngestTelemetryDto = z.object({
  deviceSerial: z.string().min(1).max(60),
  vehicleId: z.string().uuid(),
  points: z.array(TelemetryPointDto).min(1).max(MAX_TELEMETRY_POINTS),
});
export type IngestTelemetryDto = z.infer<typeof IngestTelemetryDto>;

/** How the app is talking to the device (Android can be USB-tethered since SDK 6.x). */
export const ConnectionTypeEnum = z.enum(['BLE', 'USB']);

/** §7.6 — BLE state transitions reported by the app. */
export const IngestBleStateDto = z.object({
  deviceSerial: z.string().min(1).max(60),
  state: z.enum(['CONNECTED', 'OUT_OF_RANGE', 'DISCONNECTED']),
  at: isoDateTime.optional(),
  /** SDK 6.11 — `USB` when the Android app is tethered; stored on `Device.connectionType`. */
  connectionType: ConnectionTypeEnum.optional(),
});
export type IngestBleStateDto = z.infer<typeof IngestBleStateDto>;

/** §7.7 — stored-event backlog and firmware heartbeat, plus the SDK 6.11 `TrackerInfo`. */
export const IngestDeviceStatusDto = z.object({
  deviceSerial: z.string().min(1).max(60),
  storedEventsCount: z.number().int().min(0).max(100000),
  /** Main firmware (`TrackerInfo.mainVersion`). `mainFirmware` is the SDK-named alias. */
  firmware: z.string().max(20).optional(),
  mainFirmware: z.string().max(20).optional(),
  bleFirmware: z.string().max(20).optional(),
  sdkVersion: z.string().max(20).optional(),
  /** Raw `TrackerInfo.productName` (`PT30`, `PT40-C`, …) — normalised to `Device.model`. */
  productName: z.string().trim().max(40).optional(),
  /** PT40 only. */
  imei: z.string().trim().max(20).optional(),
  /** VIN read by the device (PT30 `TrackerInfo.vin` / `GetVehicleInfo`). */
  reportedVin: z
    .string()
    .trim()
    .max(20)
    .transform((v) => v.toUpperCase())
    .optional(),
  connectionType: ConnectionTypeEnum.optional(),
  busType: BusTypeInput,
  appPlatform: z.enum(['IOS', 'ANDROID']).optional(),
  /** Device told us it dropped records → §7.8 malfunction `R`. */
  recordsLost: z.boolean().default(false),
  /** Consecutive failed transfer attempts reported by the app → §7.8 malfunction `S`. */
  consecutiveTransferFailures: z.number().int().min(0).max(1000).default(0),
});
export type IngestDeviceStatusDto = z.infer<typeof IngestDeviceStatusDto>;

/**
 * SDK `EventParam` (Android) / `EventType` (iOS) names -> `DeviceRawEventType`. The MEMS
 * events are the device's own harsh-driving detections (thresholds = `DRIVING_*` system vars).
 */
export const SDK_EVENT_TYPE_MAP: Record<string, DeviceRawEventTypeName> = {
  EV_POWER_ON: 'POWER_ON',
  EV_POWER_OFF: 'POWER_OFF',
  EV_IGNITION_ON: 'IGNITION_ON',
  EV_IGNITION_OFF: 'IGNITION_OFF',
  EV_ENGINE_ON: 'ENGINE_ON',
  EV_ENGINE_OFF: 'ENGINE_OFF',
  EV_TRIP_START: 'TRIP_START',
  EV_TRIP_END: 'TRIP_END',
  EV_PERIODIC: 'PERIODIC',
  EV_BLE_ON: 'BLE_ON',
  EV_BLE_OFF: 'BLE_OFF',
  EV_BUS_ON: 'BUS_ON',
  EV_BUS_OFF: 'BUS_OFF',
  EV_MEMS_ACC: 'HARSH_ACCEL',
  EV_MEMS_BRK: 'HARSH_BRAKE',
  EV_MEMS_COR: 'HARSH_CORNER',
  EV_INTERMEDIATE: 'INTERMEDIATE',
  EV_UNKNOWN: 'UNKNOWN',
};

export const DEVICE_RAW_EVENT_TYPES = [
  'POWER_ON',
  'POWER_OFF',
  'IGNITION_ON',
  'IGNITION_OFF',
  'ENGINE_ON',
  'ENGINE_OFF',
  'TRIP_START',
  'TRIP_END',
  'PERIODIC',
  'BLE_ON',
  'BLE_OFF',
  'BUS_ON',
  'BUS_OFF',
  'HARSH_ACCEL',
  'HARSH_BRAKE',
  'HARSH_CORNER',
  'INTERMEDIATE',
  'UNKNOWN',
] as const;
export type DeviceRawEventTypeName = (typeof DEVICE_RAW_EVENT_TYPES)[number];

/** SDK name (`EV_MEMS_BRK`, any case), our enum name (`HARSH_BRAKE`) or anything else ->
 * `UNKNOWN`. A raw device event is never rejected for an unfamiliar type label. */
export function normaliseDeviceEventType(value: string): DeviceRawEventTypeName {
  const key = value.trim().toUpperCase();
  if (Object.hasOwn(SDK_EVENT_TYPE_MAP, key)) return SDK_EVENT_TYPE_MAP[key];
  if ((DEVICE_RAW_EVENT_TYPES as readonly string[]).includes(key)) return key as DeviceRawEventTypeName;
  if (Object.hasOwn(SDK_EVENT_TYPE_MAP, `EV_${key}`)) return SDK_EVENT_TYPE_MAP[`EV_${key}`];
  return 'UNKNOWN';
}

/** The SDK hands odometer/engine hours over as strings; accept either. */
const numberish = z
  .union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)])
  .pipe(z.number().min(0));

/** One raw SDK `TelemetryEvent` / `EventFrame` (live or stored). Metric, as the SDK sends it. */
export const DeviceRawEventDto = z.object({
  type: z.string().min(1).max(40).transform(normaliseDeviceEventType),
  /** SDK event number of that day; (seq, occurredAt) is the device's ACK key. */
  seq: z.number().int().min(0).max(2_147_483_647),
  /** HOS sequence index (SDK 6.10+). */
  hsi: z.number().int().min(0).max(2_147_483_647).nullish(),
  occurredAt: isoDateTime,
  live: z.boolean(),
  latitude: latitude.nullish(),
  longitude: longitude.nullish(),
  headingDeg: z.number().int().min(0).max(359).nullish(),
  gpsLocked: z.boolean().nullish(),
  gpsSatellites: z.number().int().min(0).max(99).nullish(),
  gpsDop: z.number().min(0).max(999).nullish(),
  gpsAgeSec: z.number().int().min(0).max(2_147_483_647).nullish(),
  odometerKm: numberish.nullish(),
  speedKmh: z.number().min(0).max(400).nullish(),
  engineHours: numberish.nullish(),
  rpm: z.number().int().min(0).max(10000).nullish(),
  obd2: z.boolean().nullish(),
  engineAgeSec: z.number().int().min(0).max(2_147_483_647).nullish(),
});
export type DeviceRawEventDto = z.infer<typeof DeviceRawEventDto>;

/** `POST /ingest/device-events` — same ceilings as `/ingest/events` (500 / 1 MB). */
export const IngestDeviceEventsDto = z.object({
  deviceSerial: z.string().min(1).max(60),
  vehicleId: z.string().uuid(),
  events: z.array(DeviceRawEventDto).min(1).max(MAX_BATCH_EVENTS),
});
export type IngestDeviceEventsDto = z.infer<typeof IngestDeviceEventsDto>;
