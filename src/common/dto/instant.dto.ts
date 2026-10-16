import { z } from 'zod';
import { isCalendarDay } from './calendar-day.dto';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MESSAGE = 'Expected an ISO-8601 date-time (e.g. 2026-10-16T08:00:00Z)';

/**
 * B3-04 — a strict instant for web request bodies. `z.coerce.date()` ran `new Date(value)`, so
 * `null` and `0` became 1970-01-01 and passed. This accepts only an ISO-8601 date-time with `Z`
 * or an offset, or a `YYYY-MM-DD` calendar day (UTC midnight, as before); anything else — `null`,
 * numbers, `''`, impossible dates — is a 422. It never means "clear": a field that may be cleared
 * must add an explicit `.nullable()` and say so.
 */
export const InstantSchema = z
  .string({ invalid_type_error: MESSAGE })
  .refine((value) => (DATE_ONLY.test(value) ? isCalendarDay(value) : z.string().datetime({ offset: true }).safeParse(value).success), MESSAGE)
  .transform((value) => new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value));
