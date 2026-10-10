import { buildSystemVars, configVersion, isVinMismatch, modelFromProductName } from './system-vars.util';

const device = {
  periodicConnectedSec: 30,
  periodicNoBleSec: 120,
  harshAccelMg: 300,
  harshBrakeMg: 450,
  harshCornerMg: 0,
  autoFirmware: true,
  shareDiagnostics: true,
};

describe('system-vars.util (PT SDK 6.11, D-135)', () => {
  it('maps Device columns to SDK system variables; EVENTS_STORED and HSI_MODE are fixed at 1', () => {
    expect(buildSystemVars(device)).toEqual({
      PERIODIC_EVENT_GAP: 30,
      PERIODIC_EVENT_GAP_NOBLE: 120,
      EVENTS_STORED: 1,
      DRIVING_ACCL: 300,
      DRIVING_BRAKING: 450,
      DRIVING_CORNERING: 0,
      HSI_MODE: 1,
    });
  });

  it('configVersion is stable and changes with any applied value', () => {
    expect(configVersion(device)).toBe(configVersion({ ...device }));
    expect(configVersion(device)).not.toBe(configVersion({ ...device, harshCornerMg: 150 }));
    expect(configVersion(device)).not.toBe(configVersion({ ...device, autoFirmware: false }));
  });

  it.each([
    ['PT40-C', 'PT40'],
    ['pt40', 'PT40'],
    ['PT30', 'PT30'],
    ['PT30-X', 'PT30'],
    ['Eldman', null],
    [undefined, null],
  ])('productName %p -> model %p', (name, model) => {
    expect(modelFromProductName(name)).toBe(model);
  });

  it('VIN mismatch ignores case/whitespace and never fires without both sides', () => {
    expect(isVinMismatch('1fujgldr7clbp8834', '1FUJGLDR7CLBP8834')).toBe(false);
    expect(isVinMismatch('1FUJGLDR7CLBP8835', '1FUJGLDR7CLBP8834')).toBe(true);
    expect(isVinMismatch(undefined, '1FUJGLDR7CLBP8834')).toBe(false);
    expect(isVinMismatch('1FUJGLDR7CLBP8834', '')).toBe(false);
  });
});
