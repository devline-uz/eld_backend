import { CreateGeofenceDto, UpdateGeofenceDto } from './dto/geofences.dto';
import { GeofencesService } from './geofences.service';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_A = '22222222-2222-4222-8222-222222222222';
const UNIT_B = '33333333-3333-4333-8333-333333333333';

function buildService(
  geocoderUrl: string | undefined = undefined,
  knownGroups: string[] = [GROUP_ID],
  liveUnits: string[] = [UNIT_A, UNIT_B],
) {
  // The re-read after a write (create/update answer like GET) sees the scalar columns just written;
  // the relation writes are not echoed back.
  let written: Record<string, unknown> = {};
  const remember = (data: unknown) => {
    const { vehicleGroup: _g, vehicles: _v, ...scalars } = data as Record<string, unknown>;
    written = scalars;
  };
  const repo = {
    findWithGroup: jest.fn(async (id: string) => ({
      id,
      type: 'ADDRESS',
      vehicleGroupId: null as string | null,
      vehicleGroup: null as { name: string } | null,
      vehicles: [] as Array<{ vehicle: { id: string; unitNumber: string } }>,
      ...written,
    })),
    groupExists: jest.fn(async (id: string) => knownGroups.includes(id)),
    countLiveVehicles: jest.fn(async (ids: string[]) => ids.filter((id) => liveUnits.includes(id)).length),
    create: jest.fn(async (data: unknown) => {
      remember(data);
      return { id: 'gf_new', ...(data as object) };
    }),
    update: jest.fn(async (_where: unknown, data: unknown) => {
      remember(data);
      return { id: 'gf_1', ...(data as object) };
    }),
  };
  const config = { get: jest.fn(() => geocoderUrl) };
  const service = new GeofencesService(repo as never, config as never);
  return { service, repo, config };
}

describe('GeofencesService — §20 B-93 ADDRESS geocoding', () => {
  it('rejects an ADDRESS create with GEOCODER_NOT_CONFIGURED when GEOCODER_URL is unset', async () => {
    const { service } = buildService(undefined);
    await expect(
      service.create({ name: 'Cust dock', type: 'ADDRESS', address: '123 Main St', radiusMi: 0.5 } as never),
    ).rejects.toMatchObject({ code: 'GEOCODER_NOT_CONFIGURED' });
  });

  it('geocodes and stores centerLat/centerLon when GEOCODER_URL is set', async () => {
    const { service, repo } = buildService('http://nominatim.local');
    global.fetch = jest.fn(async () => new Response(JSON.stringify([{ lat: '40.0', lon: '-83.0' }]), { status: 200 })) as never;
    await service.create({ name: 'Cust dock', type: 'ADDRESS', address: '123 Main St', radiusMi: 0.5 } as never);
    const data = repo.create.mock.calls[0][0] as { centerLat?: number; centerLon?: number };
    expect(data.centerLat).toBe(40.0);
    expect(data.centerLon).toBe(-83.0);
  });

  it('accepts radiusMeters as an alias of radiusMi for a CIRCLE', async () => {
    const { service, repo } = buildService(undefined);
    await service.create({ name: 'Terminal', type: 'CIRCLE', centerLat: 40, centerLon: -83, radiusMeters: 1.5 } as never);
    const data = repo.create.mock.calls[0][0] as { radiusMi?: number; radiusMeters?: number };
    expect(data.radiusMi).toBe(1.5);
    expect(data.radiusMeters).toBeUndefined();
  });
});

describe('GeofencesService — colour + count as yard move (overlay 11.1)', () => {
  it('stores colour and countAsYardMove sent on create', async () => {
    const { service, repo } = buildService(undefined);
    const dto = CreateGeofenceDto.parse({
      name: 'Yard A',
      type: 'CIRCLE',
      centerLat: 40,
      centerLon: -83,
      radiusMi: 0.5,
      colour: 'GREEN',
      countAsYardMove: true,
    });
    const created = await service.create(dto);
    expect(repo.create.mock.calls[0][0]).toMatchObject({ colour: 'GREEN', countAsYardMove: true });
    expect(created).toMatchObject({ colour: 'GREEN', countAsYardMove: true });
  });

  it('defaults colour to BLUE and countAsYardMove to false when omitted', () => {
    const dto = CreateGeofenceDto.parse({ name: 'Yard A', type: 'CIRCLE', centerLat: 40, centerLon: -83, radiusMi: 0.5 });
    expect(dto.colour).toBe('BLUE');
    expect(dto.countAsYardMove).toBe(false);
  });

  it('rejects a colour outside the fixed palette', () => {
    const result = CreateGeofenceDto.safeParse({
      name: 'Yard A',
      type: 'CIRCLE',
      centerLat: 40,
      centerLon: -83,
      radiusMi: 0.5,
      colour: 'PINK',
    });
    expect(result.success).toBe(false);
  });

  it('passes colour and countAsYardMove through on update', async () => {
    const { service, repo } = buildService(undefined);
    const dto = UpdateGeofenceDto.parse({ colour: 'RED', countAsYardMove: true });
    await service.update('gf_1', dto);
    expect(repo.update).toHaveBeenCalledWith({ id: 'gf_1' }, expect.objectContaining({ colour: 'RED', countAsYardMove: true }));
  });

  it('leaves both fields untouched on an update that omits them', () => {
    const dto = UpdateGeofenceDto.parse({ name: 'Renamed' });
    expect(dto).not.toHaveProperty('colour');
    expect(dto).not.toHaveProperty('countAsYardMove');
  });
});

describe('GeofencesService — §20 B-104 "Applies to" vehicle group', () => {
  const base = { name: 'Yard A', type: 'CIRCLE', centerLat: 40, centerLon: -83, radiusMi: 0.5 };

  it('connects the vehicle group on create', async () => {
    const { service, repo } = buildService(undefined);
    await service.create(CreateGeofenceDto.parse({ ...base, vehicleGroupId: GROUP_ID }));
    const data = repo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(data.vehicleGroup).toEqual({ connect: { id: GROUP_ID } });
    expect(data).not.toHaveProperty('vehicleGroupId');
  });

  it('treats null / absent vehicleGroupId as "all groups" (no relation written)', async () => {
    const { service, repo } = buildService(undefined);
    await service.create(CreateGeofenceDto.parse({ ...base, vehicleGroupId: null }));
    await service.create(CreateGeofenceDto.parse(base));
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty('vehicleGroup');
    expect(repo.create.mock.calls[1][0]).not.toHaveProperty('vehicleGroup');
    expect(repo.groupExists).not.toHaveBeenCalled();
  });

  it('rejects an unknown (e.g. other-carrier) group with 404 VEHICLE_GROUP_NOT_FOUND', async () => {
    const { service, repo } = buildService(undefined, []);
    await expect(service.create(CreateGeofenceDto.parse({ ...base, vehicleGroupId: GROUP_ID }))).rejects.toMatchObject({
      code: 'VEHICLE_GROUP_NOT_FOUND',
    });
    await expect(service.update('gf_1', UpdateGeofenceDto.parse({ vehicleGroupId: GROUP_ID }))).rejects.toMatchObject({
      code: 'VEHICLE_GROUP_NOT_FOUND',
    });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid vehicleGroupId at validation', () => {
    expect(CreateGeofenceDto.safeParse({ ...base, vehicleGroupId: 'grp_1' }).success).toBe(false);
    expect(UpdateGeofenceDto.safeParse({ vehicleGroupId: 'grp_1' }).success).toBe(false);
  });

  it('disconnects on update with null and leaves the group untouched when omitted', async () => {
    const { service, repo } = buildService(undefined);
    await service.update('gf_1', UpdateGeofenceDto.parse({ vehicleGroupId: null }));
    await service.update('gf_1', UpdateGeofenceDto.parse({ name: 'Renamed' }));
    expect(repo.update.mock.calls[0][1]).toMatchObject({ vehicleGroup: { disconnect: true } });
    expect(repo.update.mock.calls[1][1]).not.toHaveProperty('vehicleGroup');
  });

  it('returns vehicleGroupId + vehicleGroupName on detail, and null after the group was deleted (SetNull)', async () => {
    const { service, repo } = buildService(undefined);
    repo.findWithGroup.mockResolvedValueOnce({ id: 'gf_1', type: 'CIRCLE', vehicleGroupId: GROUP_ID, vehicleGroup: { name: 'Northeast' }, vehicles: [] });
    await expect(service.get('gf_1')).resolves.toEqual({
      id: 'gf_1',
      type: 'CIRCLE',
      vehicleGroupId: GROUP_ID,
      vehicleGroupName: 'Northeast',
      vehicleIds: [],
      vehicles: [],
    });
    // After `DELETE /vehicle-groups/:id` the FK's ON DELETE SET NULL leaves the fence with no group.
    await expect(service.get('gf_1')).resolves.toMatchObject({ vehicleGroupId: null, vehicleGroupName: null });
  });

  it('flattens the group name into every list row', async () => {
    const repo = {
      listAll: jest.fn(async () => [{ id: 'gf_1', vehicleGroupId: GROUP_ID, vehicleGroup: { name: 'Northeast' }, vehicles: [] }]),
    };
    const service = new GeofencesService(repo as never, { get: jest.fn() } as never);
    await expect(service.list()).resolves.toEqual({
      items: [{ id: 'gf_1', vehicleGroupId: GROUP_ID, vehicleGroupName: 'Northeast', vehicleIds: [], vehicles: [] }],
    });
  });
});

describe('GeofencesService — "Applies to" specific units (overlay 11.1)', () => {
  const base = { name: 'Yard A', type: 'CIRCLE', centerLat: 40, centerLon: -83, radiusMi: 0.5 };

  it('writes one join row per unit on create and answers with vehicleIds + vehicles', async () => {
    const { service, repo } = buildService(undefined);
    repo.findWithGroup.mockResolvedValueOnce({
      id: 'gf_new',
      type: 'CIRCLE',
      vehicleGroupId: null,
      vehicleGroup: null,
      vehicles: [{ vehicle: { id: UNIT_A, unitNumber: '101' } }, { vehicle: { id: UNIT_B, unitNumber: '102' } }],
    });
    const created = await service.create(CreateGeofenceDto.parse({ ...base, vehicleIds: [UNIT_A, UNIT_B, UNIT_A] }));
    const data = repo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(data.vehicles).toEqual({ create: [{ vehicleId: UNIT_A }, { vehicleId: UNIT_B }] });
    expect(data).not.toHaveProperty('vehicleGroup');
    expect(data).not.toHaveProperty('vehicleIds');
    expect(repo.countLiveVehicles).toHaveBeenCalledWith([UNIT_A, UNIT_B]);
    expect(repo.findWithGroup).toHaveBeenCalledWith('gf_new');
    expect(created).toMatchObject({
      id: 'gf_new',
      vehicleGroupId: null,
      vehicleGroupName: null,
      vehicleIds: [UNIT_A, UNIT_B],
      vehicles: [
        { id: UNIT_A, unitNumber: '101' },
        { id: UNIT_B, unitNumber: '102' },
      ],
    });
  });

  it('writes no join rows for an empty / absent vehicleIds (every unit)', async () => {
    const { service, repo } = buildService(undefined);
    await service.create(CreateGeofenceDto.parse({ ...base, vehicleIds: [] }));
    await service.create(CreateGeofenceDto.parse({ ...base, vehicleGroupId: null }));
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty('vehicles');
    expect(repo.create.mock.calls[1][0]).not.toHaveProperty('vehicles');
    expect(repo.countLiveVehicles).not.toHaveBeenCalled();
  });

  it('rejects an unknown or deleted unit with 404 VEHICLE_NOT_FOUND on create and update', async () => {
    const { service, repo } = buildService(undefined, [GROUP_ID], [UNIT_A]);
    await expect(service.create(CreateGeofenceDto.parse({ ...base, vehicleIds: [UNIT_A, UNIT_B] }))).rejects.toMatchObject({
      code: 'VEHICLE_NOT_FOUND',
      status: 404,
    });
    await expect(service.update('gf_1', UpdateGeofenceDto.parse({ vehicleIds: [UNIT_B] }))).rejects.toMatchObject({
      code: 'VEHICLE_NOT_FOUND',
    });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('accepts re-sending a unit already on the fence even if it was soft-deleted since', async () => {
    const { service, repo } = buildService(undefined, [GROUP_ID], [UNIT_B]);
    repo.findWithGroup.mockResolvedValueOnce({
      id: 'gf_1',
      type: 'CIRCLE',
      vehicleGroupId: null,
      vehicleGroup: null,
      vehicles: [{ vehicle: { id: UNIT_A, unitNumber: '101' } }],
    });
    await service.update('gf_1', UpdateGeofenceDto.parse({ vehicleIds: [UNIT_A, UNIT_B] }));
    expect(repo.countLiveVehicles).toHaveBeenCalledWith([UNIT_B]);
    expect(repo.update.mock.calls[0][1]).toMatchObject({
      vehicles: { deleteMany: {}, create: [{ vehicleId: UNIT_A }, { vehicleId: UNIT_B }] },
    });
  });

  it('switching to units on update replaces the unit rows and drops the group', async () => {
    const { service, repo } = buildService(undefined);
    await service.update('gf_1', UpdateGeofenceDto.parse({ vehicleIds: [UNIT_B] }));
    expect(repo.update.mock.calls[0][1]).toMatchObject({
      vehicleGroup: { disconnect: true },
      vehicles: { deleteMany: {}, create: [{ vehicleId: UNIT_B }] },
    });
  });

  it('switching to a group on update connects it and clears the unit rows', async () => {
    const { service, repo } = buildService(undefined);
    await service.update('gf_1', UpdateGeofenceDto.parse({ vehicleGroupId: GROUP_ID }));
    await service.update('gf_1', UpdateGeofenceDto.parse({ vehicleGroupId: GROUP_ID, vehicleIds: [] }));
    for (const [, data] of repo.update.mock.calls) {
      expect(data).toMatchObject({
        vehicleGroup: { connect: { id: GROUP_ID } },
        vehicles: { deleteMany: {}, create: [] },
      });
    }
  });

  it('`vehicleIds: []` clears the units without touching the group; absent leaves both alone', async () => {
    const { service, repo } = buildService(undefined);
    await service.update('gf_1', UpdateGeofenceDto.parse({ vehicleIds: [] }));
    await service.update('gf_1', UpdateGeofenceDto.parse({ name: 'Renamed' }));
    expect(repo.update.mock.calls[0][1]).toMatchObject({ vehicles: { deleteMany: {}, create: [] } });
    expect(repo.update.mock.calls[0][1]).not.toHaveProperty('vehicleGroup');
    expect(repo.update.mock.calls[1][1]).not.toHaveProperty('vehicles');
    expect(repo.update.mock.calls[1][1]).not.toHaveProperty('vehicleGroup');
  });

  it('`vehicleGroupId: null` alone resets the group and leaves the units unchanged', async () => {
    const { service, repo } = buildService(undefined);
    await service.update('gf_1', UpdateGeofenceDto.parse({ vehicleGroupId: null }));
    expect(repo.update.mock.calls[0][1]).toMatchObject({ vehicleGroup: { disconnect: true } });
    expect(repo.update.mock.calls[0][1]).not.toHaveProperty('vehicles');
  });

  it('update answers with the re-read view (vehicleIds + vehicles)', async () => {
    const { service, repo } = buildService(undefined);
    repo.findWithGroup
      .mockResolvedValueOnce({ id: 'gf_1', type: 'CIRCLE', vehicleGroupId: GROUP_ID, vehicleGroup: { name: 'Northeast' }, vehicles: [] })
      .mockResolvedValueOnce({
        id: 'gf_1',
        type: 'CIRCLE',
        vehicleGroupId: null,
        vehicleGroup: null,
        vehicles: [{ vehicle: { id: UNIT_A, unitNumber: '101' } }],
      });
    await expect(service.update('gf_1', UpdateGeofenceDto.parse({ vehicleIds: [UNIT_A] }))).resolves.toEqual({
      id: 'gf_1',
      type: 'CIRCLE',
      vehicleGroupId: null,
      vehicleGroupName: null,
      vehicleIds: [UNIT_A],
      vehicles: [{ id: UNIT_A, unitNumber: '101' }],
    });
  });
});
