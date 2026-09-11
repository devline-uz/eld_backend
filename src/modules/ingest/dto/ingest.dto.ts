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

/** §5.6 — Virtual Dashboard point. All inputs metric; the DB stores imperial. */
export const TelemetryPointDto = z.object({
  time: isoDateTime,
  latitude,
  longitude,
  speedKmh: z.number().min(0).max(400).nullish(),
  headingDeg: z.number().int().min(0).max(359).nullish(),
  odometerKm: z.number().min(0).nullish(),
  engineHours: z.number().min(0).nullish(),
  idleHours: z.number().min(0).nullish(),
  ptoHours: z.number().min(0).nullish(),
  engineOn: z.boolean().nullish(),
  rpm: z.number().int().min(0).max(10000).nullish(),
  gear: z.string().max(8).nullish(),
  seatBelt: z.boolean().nullish(),
  loadPct: z.number().int().min(0).max(100).nullish(),
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
  dtcCount: z.number().int().min(0).nullish(),
  /** §5.7 — optional per-code breakdown behind `dtcCount`; absent when the SDK only reports
   * the count. Phase 7 (eld-fleet-ops) persists these into `DiagnosticTroubleCode`. */
  dtcCodes: z
    .array(
      z.object({
        spn: z.number().int().min(0).max(999999).nullish(),
        fmi: z.number().int().min(0).max(31).nullish(),
        source: z.string().max(40).nullish(),
        description: z.string().max(200).nullish(),
      }),
    )
    .max(20)
    .nullish(),
  busType: z.enum(['J1939', 'J1708', 'OBD_II']).nullish(),
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

/** §7.6 — BLE state transitions reported by the app. */
export const IngestBleStateDto = z.object({
  deviceSerial: z.string().min(1).max(60),
  state: z.enum(['CONNECTED', 'OUT_OF_RANGE', 'DISCONNECTED']),
  at: isoDateTime.optional(),
});
export type IngestBleStateDto = z.infer<typeof IngestBleStateDto>;

/** §7.7 — stored-event backlog and firmware heartbeat. */
export const IngestDeviceStatusDto = z.object({
  deviceSerial: z.string().min(1).max(60),
  storedEventsCount: z.number().int().min(0).max(100000),
  firmware: z.string().max(20).optional(),
  sdkVersion: z.string().max(20).optional(),
  /** Device told us it dropped records → §7.8 malfunction `R`. */
  recordsLost: z.boolean().default(false),
  /** Consecutive failed transfer attempts reported by the app → §7.8 malfunction `S`. */
  consecutiveTransferFailures: z.number().int().min(0).max(1000).default(0),
});
export type IngestDeviceStatusDto = z.infer<typeof IngestDeviceStatusDto>;
