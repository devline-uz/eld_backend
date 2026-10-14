/** CODE-072 / CODE-073 — safety request validation. */
import { SafetyEventListQueryDto, ScorecardQueryDto, UpdateSafetyEventDto } from './safety.dto';

describe('SafetyEventListQueryDto (CODE-073)', () => {
  it('refuses an impossible date instead of rolling it over', () => {
    expect(SafetyEventListQueryDto.safeParse({ from: '2026-13-45' }).success).toBe(false);
    expect(SafetyEventListQueryDto.safeParse({ to: '2026-02-31' }).success).toBe(false);
  });

  it('refuses from after to', () => {
    const parsed = SafetyEventListQueryDto.safeParse({ from: '2026-10-10', to: '2026-10-01' });
    expect(parsed.success).toBe(false);
  });

  it('a date-only `to` includes that whole day', () => {
    const parsed = SafetyEventListQueryDto.parse({ from: '2026-10-13', to: '2026-10-13' });
    expect(parsed.from?.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(parsed.to?.toISOString()).toBe('2026-10-13T23:59:59.999Z');
  });

  it('keeps an ISO instant as it is', () => {
    const parsed = SafetyEventListQueryDto.parse({ to: '2026-10-13T15:00:00Z' });
    expect(parsed.to?.toISOString()).toBe('2026-10-13T15:00:00.000Z');
  });
});

describe('ScorecardQueryDto (CODE-073)', () => {
  it('refuses a non-calendar day and a reversed period', () => {
    expect(ScorecardQueryDto.safeParse({ periodStart: '2026-13-45' }).success).toBe(false);
    expect(ScorecardQueryDto.safeParse({ periodStart: '2026-10-10', periodEnd: '2026-10-01' }).success).toBe(false);
    expect(ScorecardQueryDto.safeParse({ periodStart: '2026-09-11', periodEnd: '2026-10-10' }).success).toBe(true);
  });
});

describe('UpdateSafetyEventDto (CODE-072)', () => {
  it('only reviews or dismisses; COACHED goes through POST /safety/coaching', () => {
    expect(UpdateSafetyEventDto.safeParse({ status: 'COACHED' }).success).toBe(false);
    expect(UpdateSafetyEventDto.safeParse({ status: 'NEW' }).success).toBe(false);
    expect(UpdateSafetyEventDto.safeParse({ status: 'REVIEWED' }).success).toBe(true);
  });

  it('a dismissal needs a reason', () => {
    expect(UpdateSafetyEventDto.safeParse({ status: 'DISMISSED' }).success).toBe(false);
    expect(UpdateSafetyEventDto.safeParse({ status: 'DISMISSED', coachingNote: 'Sensor glitch' }).success).toBe(true);
  });
});
