/** MG-BLE-1/2 (D-128) — `POST /mobile/device/mac`: the app reports, never pairs. */
import type { Device } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import type { ContextUser } from '../../core/context/request-context';
import { normalizeMac, ReportDeviceMacDto } from './dto/mobile-device.dto';
import { MobileDeviceService } from './mobile-device.service';

const DEVICE_ID = '0b6f1c2e-0000-4000-8000-000000000101';
const actor = { id: 'drv-1', type: 'driver' } as unknown as ContextUser;

function setup(opts: { device?: Partial<Device> | null; assignedVehicleId?: string | null; fill?: () => Promise<number> } = {}) {
  const device =
    opts.device === null
      ? null
      : ({ id: DEVICE_ID, serial: 'PT30_A86E', vehicleId: 'veh-1', bleMacAddress: null, ...opts.device } as Device);
  const mobile = {
    findDriver: jest.fn(async () =>
      opts.assignedVehicleId === undefined ? { id: 'drv-1', assignedVehicleId: 'veh-1' } : { id: 'drv-1', assignedVehicleId: opts.assignedVehicleId },
    ),
  };
  const devices = {
    findDevice: jest.fn(async () => device),
    fillEmptyMac: jest.fn(opts.fill ?? (async () => 1)),
    hasRecentMismatch: jest.fn(async () => false),
  };
  const audit = { insert: jest.fn(async () => ({})) };
  const events = { publish: jest.fn(async () => undefined) };
  const alertQueue = { add: jest.fn(async () => undefined) };
  const ingest = {
    resolveOwnedDevice: jest.fn(async () => ({
      device: {
        serial: 'PT30_A86E', model: 'PT30', periodicConnectedSec: 30, periodicNoBleSec: 60,
        harshAccelMg: 0, harshBrakeMg: 450, harshCornerMg: 300, autoFirmware: true, shareDiagnostics: false,
      },
    })),
  };
  const service = new MobileDeviceService(mobile as never, devices as never, audit as never, events as never, alertQueue as never, ingest as never);
  return { service, mobile, devices, audit, events, alertQueue, ingest };
}

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (err) {
    const e = err as AppException;
    return { code: (e.getResponse() as { code: string }).code, status: e.getStatus() };
  }
  throw new Error('expected an AppException');
}

describe('ReportDeviceMacDto / normalizeMac', () => {
  it.each([
    ['a4:c1:38:5e:a8:6e', 'A4:C1:38:5E:A8:6E'],
    ['A4-C1-38-5E-A8-6E', 'A4:C1:38:5E:A8:6E'],
    ['a4c1385ea86e', 'A4:C1:38:5E:A8:6E'],
  ])('%s -> %s', (input, out) => {
    expect(ReportDeviceMacDto.parse({ deviceId: DEVICE_ID, macAddress: input }).macAddress).toBe(out);
  });

  it.each(['A4:C1:38:5E:A8', 'A4:C1-38:5E:A8:6E', 'G4:C1:38:5E:A8:6E', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', ''])(
    'rejects %p',
    (input) => {
      expect(ReportDeviceMacDto.safeParse({ deviceId: DEVICE_ID, macAddress: input }).success).toBe(false);
    },
  );

  it('rejects a non-uuid deviceId', () => {
    expect(ReportDeviceMacDto.safeParse({ deviceId: 'PT30_A86E', macAddress: 'A4:C1:38:5E:A8:6E' }).success).toBe(false);
  });

  it('normalizeMac returns null for junk', () => {
    expect(normalizeMac(null)).toBeNull();
    expect(normalizeMac('zz')).toBeNull();
  });
});

describe('MobileDeviceService.reportMac', () => {
  const dto = { deviceId: DEVICE_ID, macAddress: 'A4:C1:38:5E:A8:6E' };

  it('empty stored MAC -> written (compare-and-set) and audited', async () => {
    const { service, devices, audit, alertQueue } = setup();
    await expect(service.reportMac(actor, dto)).resolves.toEqual({ deviceId: DEVICE_ID, macAddress: 'A4:C1:38:5E:A8:6E', outcome: 'STORED' });
    expect(devices.fillEmptyMac).toHaveBeenCalledWith(DEVICE_ID, 'A4:C1:38:5E:A8:6E');
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_MAC_REPORTED', objectType: 'Device', objectId: DEVICE_ID }));
    expect(alertQueue.add).not.toHaveBeenCalled();
  });

  it('equal stored MAC (other spelling) -> no-op', async () => {
    const { service, devices, audit } = setup({ device: { bleMacAddress: 'a4-c1-38-5e-a8-6e' } });
    await expect(service.reportMac(actor, dto)).resolves.toEqual({ deviceId: DEVICE_ID, macAddress: 'A4:C1:38:5E:A8:6E', outcome: 'UNCHANGED' });
    expect(devices.fillEmptyMac).not.toHaveBeenCalled();
    expect(audit.insert).not.toHaveBeenCalled();
  });

  it('equal stored MAC in a free-form back-office spelling -> no-op', async () => {
    const { service } = setup({ device: { bleMacAddress: 'A4.C1.38.5E.A8.6E' } });
    await expect(service.reportMac(actor, dto)).resolves.toMatchObject({ outcome: 'UNCHANGED' });
  });

  it('different stored MAC -> 409 DEVICE_MAC_MISMATCH, audited, back office alerted, nothing written', async () => {
    const { service, devices, audit, alertQueue, events } = setup({ device: { bleMacAddress: 'A4:C1:38:00:00:01' } });
    await expect(codeOf(service.reportMac(actor, dto))).resolves.toEqual({ code: 'DEVICE_MAC_MISMATCH', status: 409 });
    expect(devices.fillEmptyMac).not.toHaveBeenCalled();
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_MAC_MISMATCH' }));
    expect(alertQueue.add).toHaveBeenCalledWith(
      'alert.device_mac_mismatch',
      expect.objectContaining({ deviceSerial: 'PT30_A86E', storedMac: 'A4:C1:38:00:00:01', reportedMac: 'A4:C1:38:5E:A8:6E', reason: 'STORED_MAC_DIFFERS' }),
    );
    expect(events.publish).toHaveBeenCalledWith('alert.device_mac_mismatch', expect.anything());
  });

  it('B-151: a repeated mismatch by the same driver within the window is still 409 but not re-audited/re-alerted', async () => {
    const { service, devices, audit, alertQueue, events } = setup({ device: { bleMacAddress: 'A4:C1:38:00:00:01' } });
    devices.hasRecentMismatch.mockResolvedValueOnce(true);
    await expect(codeOf(service.reportMac(actor, dto))).resolves.toEqual({ code: 'DEVICE_MAC_MISMATCH', status: 409 });
    expect(devices.hasRecentMismatch).toHaveBeenCalledWith(DEVICE_ID, actor.id, expect.any(Date));
    expect(audit.insert).not.toHaveBeenCalled();
    expect(alertQueue.add).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('MAC already on another device (unique violation) -> 409 DEVICE_MAC_MISMATCH', async () => {
    const { service, alertQueue } = setup({ fill: async () => Promise.reject(Object.assign(new Error('dup'), { code: 'P2002' })) });
    await expect(codeOf(service.reportMac(actor, dto))).resolves.toEqual({ code: 'DEVICE_MAC_MISMATCH', status: 409 });
    expect(alertQueue.add).toHaveBeenCalledWith('alert.device_mac_mismatch', expect.objectContaining({ reason: 'MAC_ON_ANOTHER_DEVICE' }));
  });

  it('other write errors propagate', async () => {
    const { service } = setup({ fill: async () => Promise.reject(new Error('db down')) });
    await expect(service.reportMac(actor, dto)).rejects.toThrow('db down');
  });

  it('lost race: re-reads the stored MAC and decides against it', async () => {
    const { service, devices } = setup({ fill: async () => 0 });
    devices.findDevice
      .mockResolvedValueOnce({ id: DEVICE_ID, serial: 'PT30_A86E', vehicleId: 'veh-1', bleMacAddress: null } as Device)
      .mockResolvedValueOnce({ id: DEVICE_ID, serial: 'PT30_A86E', vehicleId: 'veh-1', bleMacAddress: 'A4:C1:38:5E:A8:6E' } as Device);
    await expect(service.reportMac(actor, dto)).resolves.toMatchObject({ outcome: 'UNCHANGED' });
  });

  it('no selected vehicle -> 409 NO_ASSIGNED_VEHICLE', async () => {
    const { service } = setup({ assignedVehicleId: null });
    await expect(codeOf(service.reportMac(actor, dto))).resolves.toEqual({ code: 'NO_ASSIGNED_VEHICLE', status: 409 });
  });

  it('a device not bound to the selected vehicle (or unknown) -> 404, never written', async () => {
    const other = setup({ device: { vehicleId: 'veh-2' } });
    await expect(codeOf(other.service.reportMac(actor, dto))).resolves.toEqual({ code: 'DEVICE_NOT_FOUND', status: 404 });
    expect(other.devices.fillEmptyMac).not.toHaveBeenCalled();
    const missing = setup({ device: null });
    await expect(codeOf(missing.service.reportMac(actor, dto))).resolves.toEqual({ code: 'DEVICE_NOT_FOUND', status: 404 });
  });

  it('unknown driver -> 404', async () => {
    const { service, mobile } = setup();
    mobile.findDriver.mockResolvedValueOnce(null as never);
    await expect(codeOf(service.reportMac(actor, dto))).resolves.toEqual({ code: 'DRIVER_NOT_FOUND', status: 404 });
  });

  it('a failing alert queue or audit write does not hide the 409', async () => {
    const { service, alertQueue, audit } = setup({ device: { bleMacAddress: 'A4:C1:38:00:00:01' } });
    alertQueue.add.mockRejectedValueOnce(new Error('redis down'));
    audit.insert.mockRejectedValueOnce(new Error('db down'));
    await expect(codeOf(service.reportMac(actor, dto))).resolves.toEqual({ code: 'DEVICE_MAC_MISMATCH', status: 409 });
  });
});

describe('MobileDeviceService.deviceConfig (PT SDK 6.11, D-135)', () => {
  it('answers the system variables of a device the driver owns, via the ingest ownership check', async () => {
    const { service, ingest } = setup();
    const config = await service.deviceConfig('drv-1', 'PT30_A86E');
    expect(ingest.resolveOwnedDevice).toHaveBeenCalledWith('PT30_A86E', 'drv-1');
    expect(config).toMatchObject({
      serial: 'PT30_A86E',
      model: 'PT30',
      autoFirmware: true,
      shareDiagnostics: false,
      systemVars: {
        PERIODIC_EVENT_GAP: 30, PERIODIC_EVENT_GAP_NOBLE: 60, EVENTS_STORED: 1,
        DRIVING_ACCL: 0, DRIVING_BRAKING: 450, DRIVING_CORNERING: 300, HSI_MODE: 1,
      },
    });
    expect(config.configVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it('propagates the ownership refusal (403/404) unchanged', async () => {
    const { service, ingest } = setup();
    ingest.resolveOwnedDevice.mockRejectedValueOnce(AppException.forbidden('Driver is not associated with this unit.'));
    expect((await codeOf(service.deviceConfig('drv-1', 'PT30_X'))).status).toBe(403);
  });
});
