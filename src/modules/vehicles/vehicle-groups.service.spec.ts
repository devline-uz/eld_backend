import { VehicleGroupsRepository } from './vehicle-groups.repository';
import { VehicleGroupsService } from './vehicle-groups.service';

function makeGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'vg_1',
    name: 'Midwest',
    description: null,
    color: '#2F6FED',
    createdAt: new Date('2026-09-25T09:00:00Z'),
    updatedAt: new Date('2026-09-25T09:00:00Z'),
    _count: { vehicles: 2 },
    ...overrides,
  };
}

describe('VehicleGroupsService', () => {
  let repo: jest.Mocked<
    Pick<
      VehicleGroupsRepository,
      'listWithCounts' | 'findWithCount' | 'findByName' | 'vehiclesOf' | 'existingVehicleIds' | 'setMembers' | 'create' | 'update' | 'delete'
    >
  >;
  let service: VehicleGroupsService;

  beforeEach(() => {
    repo = {
      listWithCounts: jest.fn(),
      findWithCount: jest.fn(),
      findByName: jest.fn(),
      vehiclesOf: jest.fn(),
      existingVehicleIds: jest.fn(),
      setMembers: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    service = new VehicleGroupsService(repo as unknown as VehicleGroupsRepository);
  });

  it('list flattens `_count` into `vehicleCount`', async () => {
    repo.listWithCounts.mockResolvedValue([makeGroup()] as never);
    const [group] = await service.list();
    expect(group).toMatchObject({ id: 'vg_1', name: 'Midwest', vehicleCount: 2 });
    expect(group).not.toHaveProperty('_count');
  });

  it('get returns the group with its units; unknown id is VEHICLE_GROUP_NOT_FOUND', async () => {
    repo.findWithCount.mockResolvedValueOnce(makeGroup());
    repo.vehiclesOf.mockResolvedValue([{ id: 'veh_1', unitNumber: '101' }] as never);
    await expect(service.get('vg_1')).resolves.toMatchObject({ id: 'vg_1', vehicles: [{ id: 'veh_1' }] });

    repo.findWithCount.mockResolvedValueOnce(null);
    await expect(service.get('missing')).rejects.toMatchObject({ code: 'VEHICLE_GROUP_NOT_FOUND' });
  });

  it('create rejects a duplicate name with 409', async () => {
    repo.findByName.mockResolvedValue(makeGroup());
    await expect(service.create({ name: 'Midwest' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create with vehicleIds validates every unit and assigns them', async () => {
    repo.findByName.mockResolvedValue(null);
    repo.existingVehicleIds.mockResolvedValue(['veh_1', 'veh_2']);
    repo.create.mockResolvedValue(makeGroup());
    repo.findWithCount.mockResolvedValue(makeGroup());

    await service.create({ name: 'Midwest', vehicleIds: ['veh_1', 'veh_2', 'veh_1'] });

    expect(repo.setMembers).toHaveBeenCalledWith('vg_1', ['veh_1', 'veh_2']);
  });

  it('an unknown vehicle id is a 404 VEHICLE_NOT_FOUND and nothing is written', async () => {
    repo.findByName.mockResolvedValue(null);
    repo.existingVehicleIds.mockResolvedValue(['veh_1']);
    await expect(service.create({ name: 'X', vehicleIds: ['veh_1', 'veh_9'] })).rejects.toMatchObject({ code: 'VEHICLE_NOT_FOUND' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('update skips the duplicate-name check when the name is unchanged', async () => {
    repo.findWithCount.mockResolvedValue(makeGroup());
    await service.update('vg_1', { name: 'Midwest', color: '#000000' });
    expect(repo.findByName).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith({ id: 'vg_1' }, { name: 'Midwest', color: '#000000' });
  });

  it('setMembers replaces the membership', async () => {
    repo.findWithCount.mockResolvedValue(makeGroup());
    repo.existingVehicleIds.mockResolvedValue([]);
    await service.setMembers('vg_1', { vehicleIds: [] });
    expect(repo.setMembers).toHaveBeenCalledWith('vg_1', []);
  });

  it('remove deletes an existing group', async () => {
    repo.findWithCount.mockResolvedValue(makeGroup());
    await service.remove('vg_1');
    expect(repo.delete).toHaveBeenCalledWith({ id: 'vg_1' });
  });
});
