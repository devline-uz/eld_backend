import { z } from 'zod';

/**
 * mobile/tz.md §21 MB-4 / screens M-28, P-13 — `POST /mobile/transfers`. Same shape as the
 * back-office `CreateTransferDto` MINUS `driverId`: the driver is always the token subject.
 * `outputFileComment` ≤ 60 chars (Appendix A header field, tz.md §10.3).
 */
export const MobileCreateTransferDto = z
  .object({
    method: z.enum(['WEB_SERVICES', 'EMAIL']),
    /** RODS day (YYYY-MM-DD) in the driver's home-terminal timezone. */
    rangeStart: z.coerce.date(),
    rangeEnd: z.coerce.date(),
    outputFileComment: z.string().trim().max(60).default(''),
    /** EMAIL only — re-validated against `*.fmcsa.dot.gov` by `FmcsaTransferService`. */
    recipient: z.string().trim().max(254).optional(),
    /** MB-18 — client UUID for an offline-queued inspection transfer; a replay returns the first result. */
    clientId: z.string().trim().min(8).max(100).optional(),
    /** MB-18 — when the driver asked for the transfer on the device (offline queue); echoed back, never in the future by more than 5 min. */
    requestedAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, { message: 'requestedAt cannot be more than 5 minutes in the future' })
      .optional(),
  })
  .refine((v) => v.method !== 'EMAIL' || Boolean(v.recipient), {
    message: 'recipient is required for an EMAIL transfer',
    path: ['recipient'],
  });
export type MobileCreateTransferDto = z.infer<typeof MobileCreateTransferDto>;

/** `GET /mobile/transfers?limit=5` — the driver's own most recent transfers (S-10 receipts). */
export const MobileTransferListQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(5),
});
export type MobileTransferListQueryDto = z.infer<typeof MobileTransferListQueryDto>;
