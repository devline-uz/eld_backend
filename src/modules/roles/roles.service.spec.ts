import { RolesService } from './roles.service';
import type { RolesRepository } from './roles.repository';

describe('RolesService — super admin rules', () => {
  let repo: { findById: jest.Mock; update: jest.Mock; delete: jest.Mock; countUsersWithRole: jest.Mock };
  let service: RolesService;
  const role = (key: string) => ({ id: `r_${key}`, key, name: key, isSystem: key === 'ADMIN' || key === 'SUPER_ADMIN', permissions: {} });

  beforeEach(() => {
    repo = { findById: jest.fn(), update: jest.fn().mockResolvedValue({}), delete: jest.fn(), countUsersWithRole: jest.fn().mockResolvedValue(0) };
    service = new RolesService(repo as unknown as RolesRepository);
  });

  it('forbids a non-SUPER_ADMIN from editing the ADMIN role (403 FORBIDDEN)', async () => {
    repo.findById.mockResolvedValue(role('ADMIN'));
    await expect(service.update('r_ADMIN', { name: 'x' }, { role: 'ADMIN' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a Super Admin can manage administrators.',
    });
    await expect(service.update('r_ADMIN', { name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lets a SUPER_ADMIN edit the ADMIN role permissions', async () => {
    repo.findById.mockResolvedValue(role('ADMIN'));
    await service.update('r_ADMIN', { name: 'Admin 2' }, { role: 'SUPER_ADMIN' });
    expect(repo.update).toHaveBeenCalled();
  });

  it('SUPER_ADMIN role is immutable even for a SUPER_ADMIN, and cannot be deleted', async () => {
    repo.findById.mockResolvedValue(role('SUPER_ADMIN'));
    await expect(service.update('r_SA', { name: 'x' }, { role: 'SUPER_ADMIN' })).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
    await expect(service.remove('r_SA')).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
  });

  it('ADMIN role cannot be deleted', async () => {
    repo.findById.mockResolvedValue(role('ADMIN'));
    await expect(service.remove('r_ADMIN')).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
  });

  it('other system roles stay immutable', async () => {
    repo.findById.mockResolvedValue({ ...role('VIEWER'), isSystem: true });
    await expect(service.update('r_V', { name: 'x' }, { role: 'SUPER_ADMIN' })).rejects.toMatchObject({ code: 'ROLE_IMMUTABLE' });
  });
});
