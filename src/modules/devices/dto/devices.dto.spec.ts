import { CreateDeviceDto, ImportDevicesDto, UpdateDeviceDto } from './devices.dto';

/** B3-10 — the web admin device form / import stores one canonical BLE MAC spelling. */
describe('devices DTO — bleMacAddress (B3-10)', () => {
  it('trims and upper-cases the MAC on create, import and update', () => {
    expect(CreateDeviceDto.parse({ serial: 'pt30_1', bleMacAddress: ' aa:bb:cc:05:00:01 ' }).bleMacAddress).toBe('AA:BB:CC:05:00:01');
    expect(UpdateDeviceDto.parse({ bleMacAddress: 'aa:bb:cc:05:00:01' }).bleMacAddress).toBe('AA:BB:CC:05:00:01');
    expect(ImportDevicesDto.parse({ devices: [{ serial: 'x', bleMacAddress: 'a4:c1' }] }).devices[0].bleMacAddress).toBe('A4:C1');
  });

  it("treats '' / whitespace as no MAC (null), so two devices without one never collide on the unique index", () => {
    expect(CreateDeviceDto.parse({ serial: 'pt30_1', bleMacAddress: '' }).bleMacAddress).toBeNull();
    expect(UpdateDeviceDto.parse({ bleMacAddress: '   ' }).bleMacAddress).toBeNull();
    expect(UpdateDeviceDto.parse({}).bleMacAddress).toBeUndefined();
    expect(CreateDeviceDto.parse({ serial: 'pt30_1', bleMacAddress: null }).bleMacAddress).toBeNull();
  });
});
