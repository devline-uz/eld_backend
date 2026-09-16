import { DashboardService } from './dashboard.service';
import type { CarrierService } from '../carrier/carrier.service';
import type { LiveFleetService } from '../live/live-fleet.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { UnidentifiedService } from '../unidentified/unidentified.service';
import type { VehiclesService } from '../vehicles/vehicles.service';
import type { ViolationsService } from '../violations/violations.service';

describe('DashboardService — reuses each feature module\'s own service via Promise.all', () => {
  const liveFleet = {
    snapshot: jest.fn().mockResolvedValue({
      items: [
        { vehicleId: 'veh_1', dutyStatus: 'DRIVING' },
        { vehicleId: 'veh_2', dutyStatus: 'ON_DUTY' },
        { vehicleId: 'veh_3', dutyStatus: 'IDLE' },
        { vehicleId: 'veh_4', dutyStatus: 'ELD_OFFLINE' },
      ],
      generatedAt: '2026-09-16T15:39:10.000Z',
    }),
  };
  const violations = { list: jest.fn().mockResolvedValue({ items: [{ id: 'vio_1' }], total: 3, page: 1, limit: 25, totalPages: 1 }) };
  const unidentified = {
    list: jest.fn().mockResolvedValue({ items: [{ id: 'seg_1', durationSec: 1200 }, { id: 'seg_2', durationSec: 600 }], total: 2, page: 1, limit: 25, totalPages: 1 }),
  };
  const notifications = { list: jest.fn().mockResolvedValue({ items: [], total: 4, page: 1, limit: 1, totalPages: 4 }) };
  const carrier = { get: jest.fn().mockResolvedValue({ id: 'carrier', name: 'Universal Logistics Inc.', timezone: 'America/New_York' }) };
  const vehicles = {
    list: jest.fn((query: { status?: string }) =>
      Promise.resolve({ items: [], total: query.status === 'ACTIVE' ? 40 : 45, page: 1, limit: 1, totalPages: 1 }),
    ),
  };

  const service = new DashboardService(
    liveFleet as unknown as LiveFleetService,
    violations as unknown as ViolationsService,
    unidentified as unknown as UnidentifiedService,
    notifications as unknown as NotificationsService,
    carrier as unknown as CarrierService,
    vehicles as unknown as VehiclesService,
  );

  it('aggregates every sub-request into one response', async () => {
    const actor = { id: 'usr_1', type: 'user' } as never;
    const now = new Date('2026-09-16T15:39:10.000Z');
    const result = await service.summary(actor, now);

    expect(result.liveFleet.counts).toEqual({ total: 4, onDuty: 2, moving: 1, idle: 1, offline: 1 });
    expect(result.violations).toEqual({ items: [{ id: 'vio_1' }], total: 3 });
    expect(result.unidentified).toEqual({ total: 2, totalDurationSec: 1800 });
    expect(result.notifications).toEqual({ unreadCount: 4 });
    expect(result.carrier).toEqual({ id: 'carrier', name: 'Universal Logistics Inc.', timezone: 'America/New_York' });
    expect(result.vehicles).toEqual({ active: 40, total: 45 });

    expect(violations.list).toHaveBeenCalledWith({ window: '24h', status: 'OPEN', page: 1, limit: 25 }, now);
    expect(unidentified.list).toHaveBeenCalledWith({ status: 'PENDING', page: 1, limit: 25 });
    expect(notifications.list).toHaveBeenCalledWith(actor, { page: 1, limit: 1, unreadOnly: true });
    expect(vehicles.list).toHaveBeenCalledWith({ page: 1, limit: 1, status: 'ACTIVE' });
    expect(vehicles.list).toHaveBeenCalledWith({ page: 1, limit: 1 });
  });
});
