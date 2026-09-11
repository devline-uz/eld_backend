import { AuditSnapshotRegistry } from './audit-snapshot.registry';

describe('AuditSnapshotRegistry (TZ §18 — before/after snapshot lookup)', () => {
  it('returns null when nothing is registered for the object type', async () => {
    const registry = new AuditSnapshotRegistry();
    await expect(registry.load('Role', 'role_1')).resolves.toBeNull();
  });

  it('returns null when no id is given, without calling the loader', async () => {
    const registry = new AuditSnapshotRegistry();
    const loader = jest.fn();
    registry.register('Role', loader);
    await expect(registry.load('Role', undefined)).resolves.toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('calls the registered loader with the given id and returns its result', async () => {
    const registry = new AuditSnapshotRegistry();
    registry.register('Role', async (id) => ({ id, name: 'Dispatcher' }));
    await expect(registry.load('Role', 'role_1')).resolves.toEqual({ id: 'role_1', name: 'Dispatcher' });
  });

  it('a later register() for the same object type replaces the earlier one', async () => {
    const registry = new AuditSnapshotRegistry();
    registry.register('Role', async () => ({ from: 'first' }));
    registry.register('Role', async () => ({ from: 'second' }));
    await expect(registry.load('Role', 'x')).resolves.toEqual({ from: 'second' });
  });

  it('swallows loader failures and returns null instead of throwing (audit must never break the request)', async () => {
    const registry = new AuditSnapshotRegistry();
    registry.register('Role', async () => {
      throw new Error('db is down');
    });
    await expect(registry.load('Role', 'role_1')).resolves.toBeNull();
  });
});
