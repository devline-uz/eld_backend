import { z } from 'zod';
import { MAX_LIST_PAGE } from '../../../common/dto/list-query.dto';
import { MAX_TRANSFER_RANGE_DAYS } from '../pre-send-checks';

/** tz.md §10.3 — `outputFileComment` is capped at 60 characters (Appendix A header field). */
const outputFileComment = z.string().trim().max(60);

const RANGE_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDayKey(key: string): boolean {
  const d = new Date(`${key}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

/**
 * B-172 — a transfer range bound: a RODS day key `YYYY-MM-DD` (kept as a string so it is NOT
 * read as UTC midnight) or an ISO date-time (an instant, mapped to the home-terminal RODS day by
 * `resolveTransferRange`). A date-only string never becomes a Date (no 02-30 -> 03-02 roll).
 */
export const transferRangeBound = z
  .string()
  .trim()
  .refine((v) => (RANGE_DAY_KEY.test(v) ? isCalendarDayKey(v) : !Number.isNaN(new Date(v).getTime())), 'Invalid date')
  .transform((v): string | Date => (RANGE_DAY_KEY.test(v) ? v : new Date(v)))
  .describe(
    "RODS day `YYYY-MM-DD` (e.g. `2026-10-06`) or ISO date-time (e.g. `2026-10-06T06:00:00Z`). Days are counted in the driver's home-terminal timezone; at most 8 inclusive.",
  );

export const CreateTransferDto = z
  .object({
    driverId: z.string().uuid(),
    method: z.enum(['WEB_SERVICES', 'EMAIL']),
    /**
     * B-172 — first / last RODS day, counted in the driver's home-terminal timezone (at most 8
     * days inclusive). `YYYY-MM-DD` is taken as that RODS day; an ISO instant is mapped to the
     * home-terminal day it falls on.
     */
    rangeStart: transferRangeBound,
    rangeEnd: transferRangeBound,
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
  page: z.coerce.number().int().min(1).max(MAX_LIST_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export type TransferListQueryDto = z.infer<typeof TransferListQueryDto>;

/** Exposed so the UI can show the §395.24 range limit without hardcoding it. */
export const TRANSFER_RANGE_LIMIT_DAYS = MAX_TRANSFER_RANGE_DAYS;
