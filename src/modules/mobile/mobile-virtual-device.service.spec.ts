/** pt30_pt40/tz.md §9.3 — `POST /mobile/virtual-devices`. */
import type { Device } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import type { ContextUser } from '../../core/context/request-context';
import { RegisterVirtualDeviceDto } from './dto/mobile-device.dto';
import { MobileVirtualDeviceService } from './mobile-virtual-device.service';

const actor = { id: 'drv-1', type: 'driver' } as ContextUser;
const dto = RegisterVirtualDeviceDto.parse({ serial: 'vpt30_a1b2', model: 'PT30', firmware: 'V1.0.0' });

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev-v', serial: 'VPT30_A1B2', model: 'PT30', isVirtual: true, firmware: 'V1.0.0', reportedVin: null,
    vehicleId: 'veh-1', status: 'ASSIGNED', pairedAt: new Date('2026-10-12T08:00:00Z'), periodicConnectedSec: 30,
    periodicNoBleSec: 30, harshAccelMg: 0, harshBrakeMg: 0, harshCornerMg: 0, ...overrides,
  } as Device;
}

function setup(opts: { enabled?: boolean; assignedVehicleId?: string | null; existing?: Device | null; occupant?: Device | null } = {}) {
  const policy = {
    assertEnabled: jest.fn(async () => {
      if (opts.enabled === false) throw new AppException('VIRTUAL_ELD_DISABLED', 'off', 403);
    }),
  };
  const mobile = {
    findDriver: jest.fn(async () => ({ id: 'drv-1', assignedVehicleId: opts.assignedVehicleId === undefined ? 'veh-1' : opts.assignedVehicleId })),
  };
  const devices = {
    findBySerial: jest.fn(async () => opts.existing ?? null),
    findByVehicle: jest.fn(async () => opts.occupant ?? null),
    pairVirtual: jest.fn(async (args: { existingId: string | null }) => device({ id: args.existingId ?? 'dev-new' })),
  };
  const audit = { insert: jest.fn(async () => ({})) };
  const service = new MobileVirtualDeviceService(mobile as never, devices as never, policy as never, audit as never);
  return { service, devices, audit, policy };
}

describe('RegisterVirtualDeviceDto', () => {
  it('upper-cases the serial', () => {
    expect(dto.serial).toBe('VPT30_A1B2');
  });

  it.each([
    [{ serial: 'PT30_A1B2', model: 'PT30' }],
    [{ serial: 'VPT30_A1B2', model: 'PT40' }],
    [{ serial: 'VPT30_A1', model: 'PT30' }],
  ])('rejects %j', (body) => {
    expect(RegisterVirtualDeviceDto.safeParse(body).success).toBe(false);
  });
});

describe('MobileVirtualDeviceService.register', () => {
  it('403 VIRTUAL_ELD_DISABLED when the switch is off — nothing is read or written', async () => {
    const { service, devices } = setup({ enabled: false });
    await expect(service.register(actor, dto)).rejects.toMatchObject({ code: 'VIRTUAL_ELD_DISABLED', status: 403 });
    expect(devices.pairVirtual).not.toHaveBeenCalled();
  });

  it('409 NO_ACTIVE_VEHICLE without a current unit', async () => {
    const { service } = setup({ assignedVehicleId: null });
    await expect(service.register(actor, dto)).rejects.toMatchObject({ code: 'NO_ACTIVE_VEHICLE', status: 409 });
  });

  it('creates an isVirtual device paired to the current unit and audits it', async () => {
    const { service, devices, audit } = setup();
    const view = await service.register(actor, dto);
    expect(devices.pairVirtual).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseId: null,
        existingId: null,
        create: expect.objectContaining({ serial: 'VPT30_A1B2', isVirtual: true, status: 'ASSIGNED', vehicle: { connect: { id: 'veh-1' } } }) as unknown,
      }),
    );
    expect(view).toMatchObject({ isVirtual: true, vehicleId: 'veh-1', systemVars: expect.any(Object) as unknown });
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_VIRTUAL_REGISTERED', actorType: 'DRIVER' }));
  });

  it('is idempotent: already paired to this unit -> no write, same device', async () => {
    const existing = device();
    const { service, devices, audit } = setup({ existing, occupant: existing });
    const view = await service.register(actor, dto);
    expect(view.id).toBe('dev-v');
    expect(devices.pairVirtual).not.toHaveBeenCalled();
    expect(audit.insert).not.toHaveBeenCalled();
  });

  it('moves with the phone: paired to another unit -> re-paired here (keeps no stale pairedAt)', async () => {
    const existing = device({ vehicleId: 'veh-9' });
    const { service, devices } = setup({ existing });
    await service.register(actor, dto);
    const args = devices.pairVirtual.mock.calls[0][0] as unknown as { existingId: string; update: { pairedAt: Date } };
    expect(args.existingId).toBe('dev-v');
    expect(args.update.pairedAt.getTime()).toBeGreaterThan(existing.pairedAt!.getTime());
  });

  it('releases another VIRTUAL device on the unit', async () => {
    const { service, devices } = setup({ occupant: device({ id: 'dev-old', serial: 'VPT30_ZZZZ' }) });
    await service.register(actor, dto);
    expect(devices.pairVirtual).toHaveBeenCalledWith(expect.objectContaining({ releaseId: 'dev-old' }));
  });

  it('never displaces a REAL ELD on the unit (409 DEVICE_ALREADY_PAIRED)', async () => {
    const { service, devices } = setup({ occupant: device({ id: 'dev-real', serial: 'PT30_A86E', isVirtual: false }) });
    await expect(service.register(actor, dto)).rejects.toMatchObject({ code: 'DEVICE_ALREADY_PAIRED', status: 409 });
    expect(devices.pairVirtual).not.toHaveBeenCalled();
  });
});
