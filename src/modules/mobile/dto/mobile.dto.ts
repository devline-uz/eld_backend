import { z } from 'zod';
import {
  annotationSchema,
  CreateLogEntryBaseDto,
  CreateLogEntryDto,
  LocationDto,
  refineSpecialCondition,
} from '../../logs/dto/logs.dto';

/** §13.4 — hard batch ceilings, same numbers `IngestEventsDto` uses (§7.3 rule 2). */
export const MAX_SYNC_CHANGES = 500;
export const MAX_SYNC_BYTES = 1024 * 1024;

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const clientId = z.string().min(8).max(64);
const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/**
 * §9.3 duty-status change made from the app (`POST /mobile/duty-status` and the `duty_status`
 * sync change). It is deliberately the SAME shape as the driver's own log correction — a
 * status change entered on the phone with no ELD device attached IS a driver self-edit
 * (`recordOrigin = 2`), and reusing `LogsService.createLogEntry` means the immutability rule
 * (§395.30(c)(2), D can never be entered/shortened this way) is enforced in exactly one place.
 * Annotation is optional here (a plain status tap is not a "correction"); a neutral default is
 * substituted so the Appendix A 4-60 char comment rule is still satisfied on the stored record.
 */
export const DutyStatusDto = CreateLogEntryBaseDto.extend({
  annotation: annotationSchema.optional(),
}).superRefine(refineSpecialCondition);
export type DutyStatusDto = z.infer<typeof DutyStatusDto>;

export const DEFAULT_DUTY_STATUS_ANNOTATION = 'Driver-reported status change';

/**
 * §9.2 / §13.6 MB-8 — certify from the sync queue; identical semantics to `POST /mobile/certify`.
 * `signatureBase64` is the offline path: a certification captured with no connectivity has no
 * `signatureImageId` yet (that id is only minted by `POST /mobile/signature`, which needs the
 * network). When both are absent the existing "no signature" certify path is unchanged —
 * backwards-compatible with every already-queued payload.
 */
export const SyncCertifyPayloadDto = z.object({
  dates: z.array(dayKeySchema).min(1).max(31),
  signatureImageId: z.string().max(200).optional(),
  signatureBase64: z.string().min(16).optional(),
  signatureMimeType: z.enum(['image/png', 'image/jpeg']).default('image/png'),
});
export type SyncCertifyPayloadDto = z.infer<typeof SyncCertifyPayloadDto>;

export const DvirDefectDto = z.object({
  part: z.enum(['TRUCK', 'TRAILER']),
  category: z.string().min(1).max(120),
  severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
  description: z.string().min(1).max(500),
  /** Reference to a photo already stored via `POST /mobile/signature` (purpose = DVIR_PHOTO), or
   *  omitted — §13.6: "DVIR photo not uploaded yet → metadata is accepted, photo follows." */
  photoAttachmentIds: z.array(z.string().uuid()).max(10).default([]),
});
export type DvirDefectDto = z.infer<typeof DvirDefectDto>;

/** §11.8 / §13.2 — `POST /mobile/dvir`. Queued offline like everything else in §13. */
export const DvirSubmitDto = z.object({
  vehicleId: z.string().uuid(),
  trailerId: z.string().uuid().optional(),
  type: z.enum(['PRE_TRIP', 'POST_TRIP', 'INTERMEDIATE']),
  submittedAt: isoDateTime,
  /** MR-11 — optional. Absent/null: the vehicle's current odometer is used when known, else it stays empty. */
  odometerMi: z.number().int().min(0).max(9_999_999).nullish(),
  location: LocationDto.optional(),
  vehicleCondition: z.enum(['SATISFACTORY', 'DEFECTS_FOUND']),
  notes: z.string().max(500).optional(),
  defects: z.array(DvirDefectDto).max(50).default([]),
  /** Base64 PNG/JPEG signature bytes, captured on-device (§6 "signature capture"). */
  signatureBase64: z.string().min(16),
  signatureMimeType: z.enum(['image/png', 'image/jpeg']).default('image/png'),
  /** MR-10 — mechanic who reviewed the unit at inspection time. A signature requires the name. */
  mechanicName: z.string().trim().min(1).max(120).nullish(),
  /** MR-10 — base64 PNG/JPEG of the mechanic's signature (same 2 MB / mime limits as the driver's). */
  mechanicSignatureBase64: z.string().min(16).nullish(),
  mechanicSignatureMimeType: z.enum(['image/png', 'image/jpeg']).nullish(),
  /** MR-9..11 — idempotency key for a DIRECT `POST /mobile/dvir` replay (the sync path has its own `clientId`). */
  clientId: clientId.nullish(),
});
export type DvirSubmitDto = z.infer<typeof DvirSubmitDto>;

/** `POST /mobile/signature` — standalone signature capture, reusable by certify and DVIR. */
export const SignatureUploadDto = z
  .object({
    purpose: z.enum(['CERTIFICATION', 'DVIR', 'DVIR_PHOTO', 'INVOICE']),
    base64: z.string().min(16),
    mimeType: z.enum(['image/png', 'image/jpeg', 'application/pdf']).default('image/png'),
  })
  .refine((v) => v.mimeType !== 'application/pdf' || v.purpose === 'INVOICE', {
    path: ['mimeType'],
    message: 'application/pdf is only accepted for purpose INVOICE.',
  });
export type SignatureUploadDto = z.infer<typeof SignatureUploadDto>;

/**
 * MR-25 — shared tablet: the driver the change belongs to when it is NOT the token's driver.
 * Accepted only for `duty_status` / `log_entry`, and only when that driver shared the unit with
 * the caller at `occurredAt` (a co-driver pairing on it, or both logged in to it per their §395
 * eventType 5 login records); otherwise the change alone is rejected with
 * `SYNC_DELEGATION_NOT_ALLOWED` (decisions.md D-117). Absent/`null` = the caller.
 */
const delegatedDriverId = z.string().uuid().nullish();

/** §13.4 — one queued mutation. `clientId` is the idempotency key (§13.6). */
export const SyncChangeDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duty_status'), clientId, occurredAt: isoDateTime, driverId: delegatedDriverId, payload: DutyStatusDto }),
  z.object({ type: z.literal('log_entry'), clientId, occurredAt: isoDateTime, driverId: delegatedDriverId, payload: CreateLogEntryDto }),
  z.object({ type: z.literal('certify'), clientId, occurredAt: isoDateTime, driverId: delegatedDriverId, payload: SyncCertifyPayloadDto }),
  z.object({ type: z.literal('dvir'), clientId, occurredAt: isoDateTime, driverId: delegatedDriverId, payload: DvirSubmitDto }),
]);
export type SyncChangeDto = z.infer<typeof SyncChangeDto>;

/** MB-11 — the app's own view of how far behind it is: oldest unsynced local record, in days,
 *  and the cumulative bytes still queued locally (§13.3/§13.4 local retention). */
export const SyncBacklogDto = z.object({
  days: z.number().min(0).max(3650),
  bytes: z.number().int().min(0),
});
export type SyncBacklogDto = z.infer<typeof SyncBacklogDto>;

export const SyncRequestDto = z.object({
  lastSyncAt: isoDateTime.optional(),
  hosEngineVersion: z.string().max(20).optional(),
  changes: z.array(SyncChangeDto).max(MAX_SYNC_CHANGES),
  backlog: SyncBacklogDto.optional(),
});
export type SyncRequestDto = z.infer<typeof SyncRequestDto>;

/** MR-27 — `PUT /mobile/saved-signature`: either fresh bytes or an id minted by `POST /mobile/signature`. */
export const SavedSignatureDto = z
  .object({
    signatureBase64: z.string().min(16).nullish(),
    mimeType: z.enum(['image/png', 'image/jpeg']).nullish(),
    signatureImageId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid signatureImageId').nullish(),
    clientId: clientId.nullish(),
  })
  .refine((v) => Boolean(v.signatureBase64) !== Boolean(v.signatureImageId), {
    message: 'Provide exactly one of signatureBase64 or signatureImageId.',
    path: ['signatureBase64'],
  });
export type SavedSignatureDto = z.infer<typeof SavedSignatureDto>;

/** MR-9 — `GET /mobile/defect-catalog?part=`. Absent = both parts. */
export const DefectCatalogQueryDto = z.object({
  part: z.enum(['TRUCK', 'TRAILER']).optional(),
});
export type DefectCatalogQueryDto = z.infer<typeof DefectCatalogQueryDto>;
