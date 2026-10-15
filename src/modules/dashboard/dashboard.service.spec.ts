import { countDriverDuty, DashboardService } from './dashboard.service';
import type { CarrierService } from '../carrier/carrier.service';
import type { LiveFleetService } from '../live/live-fleet.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { DashboardRepository } from './dashboard.repository';
import type { VehiclesService } from '../vehicles/vehicles.service';
import type { ActiveViolationsService } from '../violations/active-violations.service';

describe('DashboardService — reuses each feature module\'s own service via Promise.all', () => {
  const liveFleet = {
    snapshot: jest.fn().mockResolvedValue({
      items: [
        { vehicleId: 'veh_1', dutyStatus: 'DRIVING', driverId: 'drv_1', driverDutyStatus: 'DRIVING', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'veh_2', dutyStatus: 'ON_DUTY', driverId: 'drv_2', driverDutyStatus: 'ON_DUTY', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'veh_3', dutyStatus: 'IDLE', driverId: 'drv_3', driverDutyStatus: 'ON_DUTY', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'veh_4', dutyStatus: 'ELD_OFFLINE', driverId: null, driverDutyStatus: null, connectivity: 'ELD_OFFLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'veh_5', dutyStatus: 'DRIVING', isStale: true, driverId: 'drv_5', driverDutyStatus: 'DRIVING', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
      ],
      generatedAt: '2026-09-16T15:39:10.000Z',
    }),
  };
  const violations = { list: jest.fn().mockResolvedValue({ items: [{ id: 'vio_1' }], total: 3, page: 1, limit: 25, totalPages: 1 }) };
  // CODE-021 — an aggregate over every PENDING segment (40 × 600 s), not one 25-row page.
  const repo = { pendingUnidentified: jest.fn().mockResolvedValue({ total: 40, totalDurationSec: 24000 }) };
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
    repo as unknown as DashboardRepository,
    notifications as unknown as NotificationsService,
    carrier as unknown as CarrierService,
    vehicles as unknown as VehiclesService,
  );

  it('aggregates every sub-request into one response', async () => {
    const actor = { id: 'usr_1', type: 'user', permissions: { dashboard: 'READ', liveFleet: 'READ', drivers: 'READ', hos: 'READ', vehicles: 'READ' } } as never;
    const now = new Date('2026-09-16T15:39:10.000Z');
    const result = await service.summary(actor, now);

    // UI-003 — veh_5 (stale DRIVING) is not counted as moving.
    expect(result.liveFleet.counts).toEqual({
      total: 5,
      onDuty: 4,
      moving: 1,
      idle: 1,
      offline: 1,
      driverDuty: { assigned: 4, DRIVING: 2, ON_DUTY: 2, SLEEPER: 0, OFF_DUTY: 0, UNKNOWN: 0 },
    });
    expect(result.violations).toEqual({ items: [{ id: 'vio_1' }], total: 3 });
    expect(result.unidentified).toEqual({ total: 40, totalDurationSec: 24000 });
    expect(result.notifications).toEqual({ unreadCount: 4 });
    expect(result.carrier).toEqual({ id: 'carrier', name: 'Universal Logistics Inc.', timezone: 'America/New_York' });
    expect(result.vehicles).toEqual({ active: 40, total: 45, inactive: 3, outOfService: 2 });

    expect(violations.list).toHaveBeenCalledWith({ status: 'OPEN', page: 1, limit: 25 }, now);
    expect(repo.pendingUnidentified).toHaveBeenCalled();
    expect(notifications.list).toHaveBeenCalledWith(actor, { page: 1, limit: 1, unreadOnly: true });
    expect(vehicles.list).toHaveBeenCalledWith({ page: 1, limit: 1, status: 'ACTIVE' });
    expect(vehicles.list).toHaveBeenCalledWith({ page: 1, limit: 1 });
  });

  it('BE-009 — dashboard READ alone returns the sections empty (same shape) and never runs their queries', async () => {
    jest.clearAllMocks();
    const actor = { id: 'usr_2', type: 'user', permissions: { dashboard: 'READ' } } as never;
    const now = new Date('2026-09-16T15:39:10.000Z');
    const result = await service.summary(actor, now);

    expect(result.liveFleet).toEqual({ items: [], generatedAt: now.toISOString(), counts: { total: 0, onDuty: 0, moving: 0, idle: 0, offline: 0, driverDuty: { assigned: 0, DRIVING: 0, ON_DUTY: 0, SLEEPER: 0, OFF_DUTY: 0, UNKNOWN: 0 } } });
    expect(result.violations).toEqual({ items: [], total: 0 });
    expect(result.unidentified).toEqual({ total: 0, totalDurationSec: 0, awaitingDriver: 0, awaitingDriverDurationSec: 0 });
    expect(result.vehicles).toEqual({ active: 0, total: 0, inactive: 0, outOfService: 0 });
    expect(result.notifications).toEqual({ unreadCount: 4 });
    expect(result.carrier.name).toBe('Universal Logistics Inc.');
    expect(liveFleet.snapshot).not.toHaveBeenCalled();
    expect(violations.list).not.toHaveBeenCalled();
    expect(repo.pendingUnidentified).not.toHaveBeenCalled();
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
  it('QA LIVE-002 / LIVE-011 — counts drivers by their own HOS status (like the Drivers list) and ELD offline by connectivity', async () => {
    liveFleet.snapshot.mockResolvedValueOnce({
      items: [
        // The live repro: on-duty / driving drivers whose ELD is stale or whose unit is out of service.
        { vehicleId: 'v1', driverId: 'd1', dutyStatus: 'ELD_OFFLINE', isStale: true, driverDutyStatus: 'DRIVING', connectivity: 'ELD_OFFLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'v2', driverId: 'd2', dutyStatus: 'ELD_OFFLINE', isStale: true, driverDutyStatus: 'ON_DUTY', connectivity: 'ELD_OFFLINE', recordStatus: 'ACTIVE' },
        // BE-04 — an out-of-service unit with a silent ELD is not counted as "ELD offline".
        { vehicleId: 'v3', driverId: 'd3', dutyStatus: 'INACTIVE', driverDutyStatus: 'ON_DUTY', connectivity: 'ELD_OFFLINE', recordStatus: 'OUT_OF_SERVICE' },
        { vehicleId: 'v12', driverId: null, dutyStatus: 'INACTIVE', driverDutyStatus: null, connectivity: 'ELD_OFFLINE', recordStatus: 'INACTIVE' },
        // Live markers derived from ON / OFF: idle + yard move are on duty, PC is off duty.
        { vehicleId: 'v4', driverId: 'd4', dutyStatus: 'IDLE', driverDutyStatus: 'ON_DUTY', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'v5', driverId: 'd5', dutyStatus: 'YARD_MOVE', driverDutyStatus: 'ON_DUTY', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'v6', driverId: 'd6', dutyStatus: 'PERSONAL_CONVEYANCE', driverDutyStatus: 'OFF_DUTY', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        // Off duty with a silent ELD: still off duty, but its ELD IS offline.
        { vehicleId: 'v7', driverId: 'd7', dutyStatus: 'OFF_DUTY', driverDutyStatus: 'OFF_DUTY', connectivity: 'ELD_OFFLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'v8', driverId: 'd8', dutyStatus: 'SLEEPER', driverDutyStatus: 'SLEEPER', connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        // HOS state unavailable -> UNKNOWN slice, never silently dropped.
        { vehicleId: 'v9', driverId: 'd9', dutyStatus: 'OFF_DUTY', driverDutyStatus: null, connectivity: 'ONLINE', recordStatus: 'ACTIVE' },
        // No driver: not a driver, but its silent ELD still counts as offline.
        { vehicleId: 'v10', driverId: null, dutyStatus: 'ELD_OFFLINE', driverDutyStatus: null, connectivity: 'ELD_OFFLINE', recordStatus: 'ACTIVE' },
        { vehicleId: 'v11', driverId: null, dutyStatus: 'INACTIVE', driverDutyStatus: null, connectivity: 'NO_DEVICE', recordStatus: 'INACTIVE' },
      ],
      generatedAt: '2026-09-16T15:39:10.000Z',
    });
    const actor = { id: 'usr_1', type: 'user', permissions: { dashboard: 'READ', liveFleet: 'READ', drivers: 'READ', hos: 'READ', vehicles: 'READ' } } as never;
    const { counts } = (await service.summary(actor, new Date('2026-09-16T15:39:10.000Z'))).liveFleet;

    // Drivers list definition: every status but OFF_DUTY (Driving + On-duty + Sleeper).
    expect(counts.onDuty).toBe(6);
    expect(counts.driverDuty).toEqual({ assigned: 9, DRIVING: 1, ON_DUTY: 4, SLEEPER: 1, OFF_DUTY: 2, UNKNOWN: 1 });
    const { assigned, ...slices } = counts.driverDuty;
    expect(Object.values(slices).reduce((a, b) => a + b, 0)).toBe(assigned);
    // v1, v2, v7, v10 — ACTIVE units only (v3 OUT_OF_SERVICE and v12 INACTIVE are left out).
    expect(counts.offline).toBe(4);
  });

  it('countDriverDuty skips units without a driver and always sums to `assigned`', () => {
    const counts = countDriverDuty([
      { driverId: 'd1', driverDutyStatus: 'DRIVING' },
      { driverId: null, driverDutyStatus: null },
      { driverId: 'd2', driverDutyStatus: null },
    ]);
    expect(counts).toEqual({ assigned: 2, DRIVING: 1, ON_DUTY: 0, SLEEPER: 0, OFF_DUTY: 0, UNKNOWN: 1 });
  });
});
