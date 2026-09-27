import { MobileContactsService } from './mobile-contacts.service';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileRepository } from './mobile.repository';

function build() {
  const repo = { listStaffContacts: jest.fn() };
  const mobileRepo = { findActivePairing: jest.fn(), findDriver: jest.fn(), findCarrier: jest.fn() };
  const service = new MobileContactsService(repo as unknown as MobileFleetOpsRepository, mobileRepo as unknown as MobileRepository);
  return { service, repo, mobileRepo };
}

describe('MobileContactsService (MB-14)', () => {
  it('lists ADMIN/FLEET_MANAGER/DISPATCHER staff plus a synthetic support entry, no co-driver', async () => {
    const { service, repo, mobileRepo } = build();
    repo.listStaffContacts.mockResolvedValue([{ id: 'usr_1', firstName: 'Mike', lastName: 'Torres', phone: '555', role: { key: 'FLEET_MANAGER' } }]);
    mobileRepo.findActivePairing.mockResolvedValue(null);
    mobileRepo.findCarrier.mockResolvedValue({ name: 'Universal Logistics', phone: '555-0100' });

    const result = await service.list('drv_1');

    expect(result).toEqual([
      { id: 'usr_1', name: 'Mike Torres', role: 'FLEET_MANAGER', phone: '555' },
      { id: 'support', name: 'Universal Logistics Support', role: 'SUPPORT', phone: '555-0100' },
    ]);
  });

  it('adds the active co-driver when one is paired', async () => {
    const { service, repo, mobileRepo } = build();
    repo.listStaffContacts.mockResolvedValue([]);
    mobileRepo.findActivePairing.mockResolvedValue({ primaryDriverId: 'drv_1', coDriverId: 'drv_2' });
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', firstName: 'Jane', lastName: 'Doe', phone: '555-1' });
    mobileRepo.findCarrier.mockResolvedValue(null);

    const result = await service.list('drv_1');

    expect(result).toContainEqual({ id: 'drv_2', name: 'Jane Doe', role: 'CO_DRIVER', phone: '555-1' });
  });

  it('resolves the co-driver correctly when the caller is the pairing\'s co-driver, not primary', async () => {
    const { service, repo, mobileRepo } = build();
    repo.listStaffContacts.mockResolvedValue([]);
    mobileRepo.findActivePairing.mockResolvedValue({ primaryDriverId: 'drv_2', coDriverId: 'drv_1' });
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', firstName: 'Jane', lastName: 'Doe', phone: null });
    mobileRepo.findCarrier.mockResolvedValue(null);

    const result = await service.list('drv_1');

    expect(mobileRepo.findDriver).toHaveBeenCalledWith('drv_2');
    expect(result).toContainEqual({ id: 'drv_2', name: 'Jane Doe', role: 'CO_DRIVER', phone: null });
  });
});
