import { HOS_ENGINE_VERSION, hosEngineVersion } from './hos.constants';

describe('hos engine version', () => {
  it('is a semver string shared with the Dart engine', () => {
    expect(hosEngineVersion()).toBe(HOS_ENGINE_VERSION);
    expect(HOS_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * Pinned literal on purpose, mirroring `mobile/test/hos_engine_version_test.dart`: the two
   * engines must be bumped together, so an edit on one side alone fails a suite on both sides.
   * 1.0.1 = B-041 (DST-gap resolution changed RODS day boundaries); see D-048.
   */
  it('is pinned to the current engine release', () => {
    expect(HOS_ENGINE_VERSION).toBe('1.0.1');
  });
});
