import { DashboardService } from './dashboard.service';
import type { CarrierService } from '../carrier/carrier.service';
import type { LiveFleetService } from '../live/live-fleet.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { UnidentifiedService } from '../unidentified/unidentified.service';
import type { VehiclesService } from '../vehicles/vehicles.service';
import type { ActiveViolationsService } from '../violations/active-violations.service';

describe('DashboardService — reuses each feature module\'s own service via Promise.all', () => {
  const liveFleet = {
    snapshot: jest.fn().mockResolvedValue({
      items: [
        { vehicleId: 'veh_1', dutyStatus: 'DRIVING' },
        { vehicleId: 'veh_2', dutyStatus: 'ON_DUTY' },
        { vehicleId: 'veh_3', dutyStatus: 'IDLE' },
        { vehicleId: 'veh_4', dutyStatus: 'ELD_OFFLINE' },
        { vehicleId: 'veh_5', dutyStatus: 'DRIVING', isStale: true },
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
      Promise.resolve({
        items: [], total: query.status === 'ACTIVE' ? 40 : 45, page: 1, limit: 1, totalPages: 1,
        statusCounts: { ACTIVE: 40, INACTIVE: 3, OUT_OF_SERVICE: 2, total: 45 },
      }),
    ),
  };

  const service = new DashboardService(
    liveFleet as unknown as LiveFleetService,
    violations as unknown as ActiveViolationsService,
    unidentified as unknown as UnidentifiedService,
    notifications as unknown as NotificationsService,
    carrier as unknown as CarrierService,
    vehicles as unknown as VehiclesService,
  );

  it('aggregates every sub-request into one response', async () => {
    const actor = { id: 'usr_1', type: 'user', permissions: { dashboard: 'READ', liveFleet: 'READ', drivers: 'READ', hos: 'READ', vehicles: 'READ' } } as never;
    const now = new Date('2026-09-16T15:39:10.000Z');
    const result = await service.summary(actor, now);

    // UI-003 — veh_5 (stale DRIVING) is not counted as moving.
    expect(result.liveFleet.counts).toEqual({ total: 5, onDuty: 3, moving: 1, idle: 1, offline: 1 });
    expect(result.violations).toEqual({ items: [{ id: 'vio_1' }], total: 3 });
    expect(result.unidentified).toEqual({ total: 2, totalDurationSec: 1800 });
    expect(result.notifications).toEqual({ unreadCount: 4 });
    expect(result.carrier).toEqual({ id: 'carrier', name: 'Universal Logistics Inc.', timezone: 'America/New_York' });
    expect(result.vehicles).toEqual({ active: 40, total: 45, inactive: 3, outOfService: 2 });

    expect(violations.list).toHaveBeenCalledWith({ status: 'OPEN', page: 1, limit: 25 }, now);
    expect(unidentified.list).toHaveBeenCalledWith({ status: 'PENDING', page: 1, limit: 25 });
    expect(notifications.list).toHaveBeenCalledWith(actor, { page: 1, limit: 1, unreadOnly: true });
    expect(vehicles.list).toHaveBeenCalledWith({ page: 1, limit: 1, status: 'ACTIVE' });
    expect(vehicles.list).toHaveBeenCalledWith({ page: 1, limit: 1 });
  });

  it('BE-009 — dashboard READ alone returns the sections empty (same shape) and never runs their queries', async () => {
    jest.clearAllMocks();
    const actor = { id: 'usr_2', type: 'user', permissions: { dashboard: 'READ' } } as never;
    const now = new Date('2026-09-16T15:39:10.000Z');
    const result = await service.summary(actor, now);

    expect(result.liveFleet).toEqual({ items: [], generatedAt: now.toISOString(), counts: { total: 0, onDuty: 0, moving: 0, idle: 0, offline: 0 } });
    expect(result.violations).toEqual({ items: [], total: 0 });
    expect(result.unidentified).toEqual({ total: 0, totalDurationSec: 0 });
    expect(result.vehicles).toEqual({ active: 0, total: 0, inactive: 0, outOfService: 0 });
    expect(result.notifications).toEqual({ unreadCount: 4 });
    expect(result.carrier.name).toBe('Universal Logistics Inc.');
    expect(liveFleet.snapshot).not.toHaveBeenCalled();
    expect(violations.list).not.toHaveBeenCalled();
    expect(unidentified.list).not.toHaveBeenCalled();
    expect(vehicles.list).not.toHaveBeenCalled();
  });

  it('BE-009 — liveFleet without drivers READ shows the map but strips driver phone numbers', async () => {
    liveFleet.snapshot.mockResolvedValueOnce({
      items: [{ vehicleId: 'veh_1', dutyStatus: 'DRIVING', driverPhone: '+15551234567' }],
      generatedAt: '2026-09-16T15:39:10.000Z',
    });
    const actor = { id: 'usr_3', type: 'user', permissions: { dashboard: 'READ', liveFleet: 'READ' } } as never;
    const result = await service.summary(actor, new Date('2026-09-16T15:39:10.000Z'));
    expect(result.liveFleet.items).toEqual([{ vehicleId: 'veh_1', dutyStatus: 'DRIVING', driverPhone: null }]);
  });
});
