import { z } from 'zod';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar day: `2026-13-45` / `2026-02-30` are refused instead of rolling over
 * (`Date.parse` turns `2026-02-30` into Mar 2). Same rule as safety's CODE-073 check.
 */
export function isCalendarDay(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** BE-10 — a `YYYY-MM-DD` calendar day; an impossible date is a 422 (zod), never a 500 downstream. */
export const CalendarDaySchema = z
  .string()
  .regex(DATE_ONLY, 'Expected YYYY-MM-DD')
  .refine((value) => !DATE_ONLY.test(value) || isCalendarDay(value), 'Not a calendar date');
