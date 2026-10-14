import { DEFAULT_ROLE_MATRIX } from './permission-matrix';
import { RolesService } from './roles.service';
import type { RolesRepository } from './roles.repository';

describe('RolesService — super admin rules', () => {
  let repo: {
    findById: jest.Mock;
    findByKey: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    countUsersWithRole: jest.Mock;
    findRoleOfUser: jest.Mock;
  };
  let service: RolesService;
  const role = (key: string, permissions: object = {}) => ({
    id: `r_${key}`,
    key,
    name: key,
    isSystem: key === 'ADMIN' || key === 'SUPER_ADMIN',
    permissions,
  });
  /** Actor ids resolve to the role they hold in the DB (`findRoleOfUser`). */
  const heldRoles: Record<string, ReturnType<typeof role>> = {
    sa_1: role('SUPER_ADMIN', DEFAULT_ROLE_MATRIX.SUPER_ADMIN),
    adm_1: role('ADMIN', DEFAULT_ROLE_MATRIX.ADMIN),
  };
  const SA = { id: 'sa_1', role: 'SUPER_ADMIN' };
  const ADM = { id: 'adm_1', role: 'ADMIN' };

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      findByKey: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (data: object) => ({ id: 'r_new', ...data })),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn(),
      countUsersWithRole: jest.fn().mockResolvedValue(0),
      findRoleOfUser: jest.fn(async (id: string) => heldRoles[id] ?? null),
    };
    service = new RolesService(repo as unknown as RolesRepository);
  });

  it('forbids a non-SUPER_ADMIN from editing the ADMIN role (403 FORBIDDEN)', async () => {
    repo.findById.mockResolvedValue(role('ADMIN'));
    await expect(service.update('r_ADMIN', { name: 'x' }, ADM)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a Super Admin can manage administrators.',
    });
    await expect(service.update('r_ADMIN', { name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lets a SUPER_ADMIN edit the ADMIN role permissions', async () => {
    repo.findById.mockResolvedValue(role('ADMIN'));
    await service.update('r_ADMIN', { name: 'Admin 2' }, SA);
    expect(repo.update).toHaveBeenCalled();
  });

  it('SUPER_ADMIN role is immutable even for a SUPER_ADMIN, and cannot be deleted', async () => {
    repo.findById.mockResolvedValue(role('SUPER_ADMIN'));
    await expect(service.update('r_SA', { name: 'x' }, SA)).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
    await expect(service.remove('r_SA')).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
  });

  it('ADMIN role cannot be deleted', async () => {
    repo.findById.mockResolvedValue(role('ADMIN'));
    await expect(service.remove('r_ADMIN')).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
  });

  it('other system roles stay immutable', async () => {
    repo.findById.mockResolvedValue({ ...role('VIEWER'), isSystem: true });
    await expect(service.update('r_V', { name: 'x' }, SA)).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
  });
});

/**
 * CODE-002 — a role author can only hand out levels they hold themselves, cannot edit the
 * role they hold, and cannot touch a role above them. SUPER_ADMIN is exempt.
 */
describe('RolesService — permission ceiling (CODE-002)', () => {
  const ALL_FULL = DEFAULT_ROLE_MATRIX.ADMIN;
  // A custom role manager: roles:FULL + users:FULL, but only READ on vehicles and NONE on integrations.
  const MANAGER_MATRIX = { ...DEFAULT_ROLE_MATRIX.VIEWER, roles: 'FULL', users: 'FULL' } as const;
  const custom = (id: string, permissions: object) => ({ id, key: id.toUpperCase(), name: id, isSystem: false, permissions });
  const managerRole = custom('r_manager', MANAGER_MATRIX);
  const MANAGER = { id: 'mgr_1', role: 'R_MANAGER' };
  const SA = { id: 'sa_1', role: 'SUPER_ADMIN' };

  let repo: Record<string, jest.Mock>;
  let service: RolesService;

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      findByKey: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (data: object) => ({ id: 'r_new', ...data })),
      update: jest.fn().mockImplementation(async (_w: unknown, data: object) => data),
      findRoleOfUser: jest.fn(async (id: string) =>
        id === 'mgr_1'
          ? managerRole
          : id === 'sa_1'
            ? { id: 'r_SUPER_ADMIN', key: 'SUPER_ADMIN', permissions: ALL_FULL, isSystem: true }
            : null,
      ),
    };
    service = new RolesService(repo as unknown as RolesRepository);
  });

  it('rejects creating an all-FULL role from a custom role (403, lists the exceeding keys)', async () => {
    const err = await service
      .create({ key: 'GOD', name: 'God', permissions: ALL_FULL }, MANAGER)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((err as Error).message).toContain('You cannot create a role with permissions above your own');
    expect((err as Error).message).toContain('integrations (FULL, you have NONE)');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('allows creating a role within the actor’s own levels', async () => {
    const permissions = { ...DEFAULT_ROLE_MATRIX.VIEWER, users: 'READ' as const };
    await service.create({ key: 'SUB', name: 'Sub', permissions }, MANAGER);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ key: 'SUB', permissions }));
  });

  it('rejects the escalation repro: holder of roles:FULL sets their own role to all-FULL', async () => {
    repo.findById.mockResolvedValue(managerRole);
    await expect(service.update('r_manager', { permissions: ALL_FULL }, MANAGER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You cannot edit the role you are assigned to.',
    });
    // Even a harmless rename of the held role is refused.
    await expect(service.update('r_manager', { name: 'Renamed' }, MANAGER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects raising another role above the actor’s levels', async () => {
    repo.findById.mockResolvedValue(custom('r_other', DEFAULT_ROLE_MATRIX.VIEWER));
    await expect(
      service.update('r_other', { permissions: { ...DEFAULT_ROLE_MATRIX.VIEWER, vehicles: 'FULL' } }, MANAGER),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { exceeding: [{ key: 'vehicles', requested: 'FULL', allowed: 'READ' }] } });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects editing a role that already sits above the actor', async () => {
    repo.findById.mockResolvedValue(custom('r_fm', DEFAULT_ROLE_MATRIX.FLEET_MANAGER));
    await expect(service.update('r_fm', { name: 'x' }, MANAGER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You cannot edit a role that has permissions above your own.',
    });
  });

  it('allows a legit edit of another role within the actor’s levels', async () => {
    repo.findById.mockResolvedValue(custom('r_other', DEFAULT_ROLE_MATRIX.VIEWER));
    const permissions = { ...DEFAULT_ROLE_MATRIX.VIEWER, roles: 'READ' as const };
    await service.update('r_other', { name: 'Other', permissions }, MANAGER);
    expect(repo.update).toHaveBeenCalledWith({ id: 'r_other' }, { name: 'Other', permissions });
  });

  it('fails closed when the actor cannot be resolved (missing/inactive user)', async () => {
    await expect(service.create({ key: 'X1', name: 'x', permissions: DEFAULT_ROLE_MATRIX.VIEWER }, { id: 'ghost' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.create({ key: 'X1', name: 'x', permissions: DEFAULT_ROLE_MATRIX.VIEWER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('caps an API-key principal at its own scope matrix', async () => {
    const keyActor = { id: 'key_1', type: 'api-key' as const, permissions: MANAGER_MATRIX };
    await expect(service.create({ key: 'GOD', name: 'God', permissions: ALL_FULL }, keyActor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repo.findRoleOfUser).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN can still create and edit any custom role at any level', async () => {
    await service.create({ key: 'GOD', name: 'God', permissions: ALL_FULL }, SA);
    expect(repo.create).toHaveBeenCalled();
    repo.findById.mockResolvedValue(managerRole);
    await service.update('r_manager', { permissions: ALL_FULL }, SA);
    expect(repo.update).toHaveBeenCalledWith({ id: 'r_manager' }, { permissions: ALL_FULL });
  });
});
