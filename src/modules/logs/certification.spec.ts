/** TZ §9.2 — Appendix A gives the certification record one digit; the count is kept elsewhere. */
import {
  CERTIFICATION_EVENT_CODE_MAX,
  UNCERTIFIED_LOGS_ALERT_DAYS,
  certificationEventCode,
  uncertifiedAlertDue,
} from './certification';

describe('certificationEventCode', () => {
  it('is 1 for the first certification of a day', () => {
    expect(certificationEventCode(0)).toBe(1);
  });

  it('walks 2..9 for re-certifications', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(certificationEventCode)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('saturates at 9 — the Appendix A limit — while the true count lives on DailyLog', () => {
    expect(certificationEventCode(9)).toBe(CERTIFICATION_EVENT_CODE_MAX);
    expect(certificationEventCode(40)).toBe(9);
  });

  it('is defensive about nonsense input', () => {
    expect(certificationEventCode(-3)).toBe(1);
    expect(certificationEventCode(Number.NaN)).toBe(1);
  });
});

describe('alert.uncertified_logs', () => {
  it('uses an 8-day threshold, everywhere', () => {
    expect(UNCERTIFIED_LOGS_ALERT_DAYS).toBe(8);
  });

  it('fires once the oldest uncertified day is 8 days old', () => {
    expect(uncertifiedAlertDue(['2026-06-01'], '2026-06-09')).toBe(true);
    expect(uncertifiedAlertDue(['2026-06-02'], '2026-06-09')).toBe(false);
    expect(uncertifiedAlertDue([], '2026-06-09')).toBe(false);
  });
});
