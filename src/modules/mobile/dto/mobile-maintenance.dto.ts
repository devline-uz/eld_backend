import { z } from 'zod';

/** M-38 — `GET /mobile/maintenance` is a plain array scoped to the driver's selected unit; no query. */

/** Money the app sends as a JSON number or a decimal string; at most 2 fraction digits. */
const Cost = z
  .union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Use a number with at most 2 decimals.').transform(Number)])
  .refine((v) => Number.isFinite(v) && v >= 0 && v <= 9_999_999.99, 'Cost must be between 0 and 9999999.99.')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Cost has at most 2 decimals.');

/**
 * M-39/M-40 — `POST /mobile/maintenance/:id/submit`. `clientId` (UUID) is the offline idempotency key
 * (SyncedChange ledger); `invoiceAttachmentId` is the `signatureImageId` returned by
 * `POST /mobile/signature { purpose: 'INVOICE', mimeType: 'application/pdf' }`.
 */
export const MaintenanceSubmitDto = z.object({
  invoiceNumber: z.string().trim().min(1).max(60),
  vendorName: z.string().trim().min(1).max(120),
  cost: Cost,
  notes: z.string().trim().max(1000).nullish(),
  invoiceAttachmentId: z.string().uuid().nullish(),
  clientId: z.string().uuid(),
});
export type MaintenanceSubmitDto = z.infer<typeof MaintenanceSubmitDto>;
