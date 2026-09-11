import { HOS_ENGINE_VERSION, hosEngineVersion } from './hos.constants';

describe('hos engine version', () => {
  it('is a semver string shared with the Dart engine', () => {
    expect(hosEngineVersion()).toBe(HOS_ENGINE_VERSION);
    expect(HOS_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
