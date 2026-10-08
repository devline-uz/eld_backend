/** MR-24 — the optional engine timestamps on the posted app state are additive and nullable. */
import { HosStateDto } from './hos-state.dto';

const base = {
  computedAt: '2026-10-08T12:00:00Z',
  hosEngineVersion: '1.0.1',
  state: {
    currentStatus: 'D',
    driveRemainingSec: 3600,
    shiftRemainingSec: 7200,
    breakRemainingSec: 1800,
    cycleRemainingSec: 36000,
    dailyTotals: { off: 0, sb: 0, drive: 0, on: 0 },
  },
};

describe('HosStateDto (MR-24 timestamps)', () => {
  it('accepts a payload without any of the new fields (old apps)', () => {
    expect(HosStateDto.safeParse(base).success).toBe(true);
  });

  it('accepts ISO strings and null', () => {
    const parsed = HosStateDto.parse({
      ...base,
      state: {
        ...base.state,
        statusSince: '2026-10-08T10:00:00Z',
        nextBreakDueAt: '2026-10-08T13:00:00-05:00',
        shiftEndsAt: null,
        cycleRecapAt: null,
        restartAvailableAt: null,
      },
    });
    expect(parsed.state.statusSince).toBe('2026-10-08T10:00:00Z');
    expect(parsed.state.shiftEndsAt).toBeNull();
  });

  it('rejects a non-ISO timestamp', () => {
    expect(HosStateDto.safeParse({ ...base, state: { ...base.state, shiftEndsAt: 'tomorrow' } }).success).toBe(false);
  });
});
