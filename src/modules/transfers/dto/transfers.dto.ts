import { z } from 'zod';
import { MAX_TRANSFER_RANGE_DAYS } from '../pre-send-checks';

/** tz.md §10.3 — `outputFileComment` is capped at 60 characters (Appendix A header field). */
const outputFileComment = z.string().trim().max(60);

export const CreateTransferDto = z
  .object({
    driverId: z.string().uuid(),
    method: z.enum(['WEB_SERVICES', 'EMAIL']),
    /** RODS day (YYYY-MM-DD) in the driver's home-terminal timezone. */
    rangeStart: z.coerce.date(),
    rangeEnd: z.coerce.date(),
    outputFileComment: outputFileComment.default(''),
    /**
     * EMAIL only. Re-validated against `*.fmcsa.dot.gov` in the service and again in the
     * worker — an offline mobile replay (§13.5) never passes through this schema.
     */
    recipient: z.string().trim().max(254).optional(),
  })
  .refine((v) => v.method !== 'EMAIL' || Boolean(v.recipient), {
    message: 'recipient is required for an EMAIL transfer',
    path: ['recipient'],
  });
export type CreateTransferDto = z.infer<typeof CreateTransferDto>;

export const TransferListQueryDto = z.object({
  driverId: z.string().uuid().optional(),
  status: z.enum(['QUEUED', 'TEST_ONLY', 'SENT', 'ACCEPTED', 'REJECTED', 'FAILED', 'ALL']).default('ALL'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export type TransferListQueryDto = z.infer<typeof TransferListQueryDto>;

/** Exposed so the UI can show the §395.24 range limit without hardcoding it. */
export const TRANSFER_RANGE_LIMIT_DAYS = MAX_TRANSFER_RANGE_DAYS;
