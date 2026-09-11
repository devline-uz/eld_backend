import { isFirmwareOutdated, MIN_PT30_FIRMWARE, RECOMMENDED_PT30_FIRMWARE } from './firmware.util';

describe('devices/firmware.util (TZ §5.4)', () => {
  it('flags firmware below L108 as outdated', () => {
    expect(isFirmwareOutdated('L107')).toBe(true);
  });

  it('accepts the minimum L108', () => {
    expect(isFirmwareOutdated(MIN_PT30_FIRMWARE)).toBe(false);
  });

  it('accepts the recommended L113', () => {
    expect(isFirmwareOutdated(RECOMMENDED_PT30_FIRMWARE)).toBe(false);
  });

  it('treats missing firmware as outdated', () => {
    expect(isFirmwareOutdated(null)).toBe(true);
    expect(isFirmwareOutdated(undefined)).toBe(true);
  });

  it('treats unparsable firmware as outdated', () => {
    expect(isFirmwareOutdated('not-a-version')).toBe(true);
  });
});
