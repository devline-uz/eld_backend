import { z } from 'zod';
import { annotationSchema, CreateLogEntryDto, LocationDto } from '../../logs/dto/logs.dto';

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
export const DutyStatusDto = CreateLogEntryDto.extend({
  annotation: annotationSchema.optional(),
});
export type DutyStatusDto = z.infer<typeof DutyStatusDto>;

export const DEFAULT_DUTY_STATUS_ANNOTATION = 'Driver-reported status change';

/** §9.2 — certify from the sync queue; identical semantics to `POST /mobile/certify`. */
export const SyncCertifyPayloadDto = z.object({
  dates: z.array(dayKeySchema).min(1).max(31),
  signatureImageId: z.string().max(200).optional(),
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
  odometerMi: z.number().int().min(0).max(9_999_999),
  location: LocationDto.optional(),
  vehicleCondition: z.enum(['SATISFACTORY', 'DEFECTS_FOUND']),
  notes: z.string().max(500).optional(),
  defects: z.array(DvirDefectDto).max(50).default([]),
  /** Base64 PNG/JPEG signature bytes, captured on-device (§6 "signature capture"). */
  signatureBase64: z.string().min(16),
  signatureMimeType: z.enum(['image/png', 'image/jpeg']).default('image/png'),
});
export type DvirSubmitDto = z.infer<typeof DvirSubmitDto>;

/** `POST /mobile/signature` — standalone signature capture, reusable by certify and DVIR. */
export const SignatureUploadDto = z.object({
  purpose: z.enum(['CERTIFICATION', 'DVIR', 'DVIR_PHOTO']),
  base64: z.string().min(16),
  mimeType: z.enum(['image/png', 'image/jpeg']).default('image/png'),
});
export type SignatureUploadDto = z.infer<typeof SignatureUploadDto>;

/** §13.4 — one queued mutation. `clientId` is the idempotency key (§13.6). */
export const SyncChangeDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duty_status'), clientId, occurredAt: isoDateTime, payload: DutyStatusDto }),
  z.object({ type: z.literal('log_entry'), clientId, occurredAt: isoDateTime, payload: CreateLogEntryDto }),
  z.object({ type: z.literal('certify'), clientId, occurredAt: isoDateTime, payload: SyncCertifyPayloadDto }),
  z.object({ type: z.literal('dvir'), clientId, occurredAt: isoDateTime, payload: DvirSubmitDto }),
]);
export type SyncChangeDto = z.infer<typeof SyncChangeDto>;

export const SyncRequestDto = z.object({
  lastSyncAt: isoDateTime.optional(),
  hosEngineVersion: z.string().max(20).optional(),
  changes: z.array(SyncChangeDto).max(MAX_SYNC_CHANGES),
});
export type SyncRequestDto = z.infer<typeof SyncRequestDto>;
