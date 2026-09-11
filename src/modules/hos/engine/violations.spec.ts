/** TZ §8.3 step 5 / §8.4 — one violation per (logDate, type). */
import { formatHours, ViolationCollector } from './violations';

describe('ViolationCollector', () => {
  const t = (iso: string) => new Date(iso);

  it('starts empty', () => expect(new ViolationCollector().list()).toEqual([]));

  it('keeps a single violation', () => {
    const c = new ViolationCollector();
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 60, 'over');
    expect(c.list()).toEqual([{ type: 'DRIVING_11', logDate: '2025-01-14', occurredAt: t('2025-01-14T12:00:00Z'), exceededBySec: 60, detail: 'over' }]);
  });

  it('never duplicates the same (logDate, type) key', () => {
    const c = new ViolationCollector();
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 60, 'a');
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T13:00:00Z'), 3600, 'b');
    expect(c.list()).toHaveLength(1);
  });

  it('keeps the earliest occurrence', () => {
    const c = new ViolationCollector();
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T13:00:00Z'), 60, 'a');
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 30, 'b');
    expect(c.list()[0].occurredAt).toEqual(t('2025-01-14T12:00:00Z'));
  });

  it('keeps the largest overrun and its detail', () => {
    const c = new ViolationCollector();
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 60, 'small');
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T13:00:00Z'), 3600, 'big');
    expect(c.list()[0]).toMatchObject({ exceededBySec: 3600, detail: 'big' });
  });

  it('does not shrink the overrun', () => {
    const c = new ViolationCollector();
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 3600, 'big');
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T13:00:00Z'), 60, 'small');
    expect(c.list()[0].exceededBySec).toBe(3600);
  });

  it('separates the same type on different days', () => {
    const c = new ViolationCollector();
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 60, 'a');
    c.add('DRIVING_11', '2025-01-15', t('2025-01-15T12:00:00Z'), 60, 'b');
    expect(c.list()).toHaveLength(2);
  });

  it('separates different types on the same day', () => {
    const c = new ViolationCollector();
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 60, 'a');
    c.add('BREAK_30', '2025-01-14', t('2025-01-14T11:00:00Z'), 60, 'b');
    expect(c.list().map((v) => v.type)).toEqual(['BREAK_30', 'DRIVING_11']);
  });

  it('sorts by occurrence then by type name', () => {
    const c = new ViolationCollector();
    c.add('SHIFT_14', '2025-01-14', t('2025-01-14T12:00:00Z'), 60, 'a');
    c.add('DRIVING_11', '2025-01-14', t('2025-01-14T12:00:00Z'), 60, 'b');
    expect(c.list().map((v) => v.type)).toEqual(['DRIVING_11', 'SHIFT_14']);
  });

  it('rounds fractional seconds', () => {
    const c = new ViolationCollector();
    c.add('BREAK_30', '2025-01-14', t('2025-01-14T12:00:00Z'), 59.6, 'a');
    expect(c.list()[0].exceededBySec).toBe(60);
  });

  it('clamps a negative overrun to zero', () => {
    const c = new ViolationCollector();
    c.add('BREAK_30', '2025-01-14', t('2025-01-14T12:00:00Z'), -5, 'a');
    expect(c.list()[0].exceededBySec).toBe(0);
  });
});

describe('formatHours', () => {
  it.each([
    [0, '0h 00m'],
    [59, '0h 00m'],
    [60, '0h 01m'],
    [3600, '1h 00m'],
    [39600, '11h 00m'],
    [41160, '11h 26m'],
    [-10, '0h 00m'],
  ])('%s s → %s', (seconds, expected) => expect(formatHours(seconds)).toBe(expected));
});
