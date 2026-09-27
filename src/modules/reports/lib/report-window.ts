import { DateTime } from 'luxon';
import type { ReportWindow } from '../dto/reports.dto';

/**
 * B-48 — resolves a schedule's `params.window` into a concrete period AT EACH RUN, in the
 * schedule's own `timezone` (never the server's, for the same DST-correctness reason
 * `hos/engine/timezone.ts` insists on driver-local RODS-day boundaries). `IFTA` params use
 * `quarter` (`YYYY-Q#`), every other generatable type uses `from`/`to` (`YYYY-MM-DD`) — see
 * `reports.dto.ts`'s per-type param schemas — so the shape produced depends on `reportType`.
 * Params without a `window` pass through unchanged (a schedule can still pin a fixed
 * `from`/`to`/`quarter`, same as before this gap was closed).
 */
export function resolveScheduleParams(
  reportType: string,
  params: Record<string, unknown>,
  timezone: string,
  now: Date,
): Record<string, unknown> {
  const window = params.window as ReportWindow | undefined;
  if (!window) return params;

  const { window: _drop, ...rest } = params;
  const nowLocal = DateTime.fromJSDate(now, { zone: timezone });

  if (reportType === 'IFTA') {
    return { ...rest, quarter: previousQuarterLabel(nowLocal, window) };
  }

  const { from, to } = previousPeriodRange(nowLocal, window);
  return { ...rest, from, to };
}

function previousQuarterLabel(nowLocal: DateTime, window: ReportWindow): string {
  // Only PREVIOUS_QUARTER is meaningful for a `quarter` param; WEEK/MONTH still resolve to
  // "the quarter that contains that period" so a mis-set schedule degrades sanely instead of
  // producing an invalid quarter string.
  const target = window === 'PREVIOUS_WEEK' ? nowLocal.minus({ weeks: 1 }) : nowLocal.minus({ quarters: 1 });
  const quarter = Math.ceil(target.month / 3);
  return `${target.year}-Q${quarter}`;
}

function previousPeriodRange(nowLocal: DateTime, window: ReportWindow): { from: string; to: string } {
  switch (window) {
    case 'PREVIOUS_WEEK': {
      // ISO week: Monday..Sunday. `nowLocal.startOf('week')` is THIS week's Monday in luxon's
      // default (ISO) week numbering.
      const thisWeekStart = nowLocal.startOf('week');
      const from = thisWeekStart.minus({ weeks: 1 });
      const to = thisWeekStart.minus({ days: 1 });
      return { from: from.toFormat('yyyy-MM-dd'), to: to.toFormat('yyyy-MM-dd') };
    }
    case 'PREVIOUS_MONTH': {
      const prevMonth = nowLocal.startOf('month').minus({ months: 1 });
      return { from: prevMonth.toFormat('yyyy-MM-dd'), to: prevMonth.endOf('month').toFormat('yyyy-MM-dd') };
    }
    case 'PREVIOUS_QUARTER': {
      const currentQuarterStartMonth = Math.floor((nowLocal.month - 1) / 3) * 3 + 1;
      const thisQuarterStart = nowLocal.set({ month: currentQuarterStartMonth }).startOf('month');
      const prevQuarterStart = thisQuarterStart.minus({ months: 3 });
      const prevQuarterEnd = thisQuarterStart.minus({ days: 1 });
      return { from: prevQuarterStart.toFormat('yyyy-MM-dd'), to: prevQuarterEnd.toFormat('yyyy-MM-dd') };
    }
  }
}
