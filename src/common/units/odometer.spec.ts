import {
  ODOMETER_MAX_DAILY_JUMP_MI,
  applyOdometerOffsetMi,
  computeOdometerOffsetMi,
  isOdometerAnomaly,
} from './odometer';

describe('units/odometer (TZ §4.3)', () => {
  it('computes the offset from dash minus device value', () => {
    expect(computeOdometerOffsetMi({ odometerMi: 23100, deviceOdometerMi: 5056 })).toBe(18044);
  });

  it('applies the offset to later device readings', () => {
    expect(applyOdometerOffsetMi(5100, 18044)).toBe(23144);
  });

  it('flags a backwards odometer', () => {
    expect(isOdometerAnomaly(5100, 5099)).toBe(true);
  });

  it('flags an implausible jump', () => {
    expect(isOdometerAnomaly(5100, 5100 + ODOMETER_MAX_DAILY_JUMP_MI + 1)).toBe(true);
  });

  it('accepts normal growth', () => {
    expect(isOdometerAnomaly(5100, 5600)).toBe(false);
  });
});
