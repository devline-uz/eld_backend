/**
 * B-6 — fleet violation list + manual resolve.
 *   resolve touches the HosViolation row only (never EldEvent/DailyLog), is audited, and only
 *   an OPEN row can be resolved; the list joins driver name and unit for W-01.
 */
import type { HosViolation } from '@prisma/client';
import type { AuditRepository } from '../audit/audit.repository';
import { ResolveViolationDto, ViolationListQueryDto } from './dto/violations.dto';
import { buildWhere, ViolationsService } from './violations.service';
import type { ViolationsRepository, ViolationWithDriver } from './violations.repository';

const NOW = new Date('2026-09-14T12:00:00Z');
const ACTOR = { id: 'usr-1', type: 'user' as const };

function violation(over: Partial<HosViolation> = {}): ViolationWithDriver {
  return {
    id: 'vio-1',
    driverId: 'drv-1',
    dailyLogId: 'dl-1',
    logDate: new Date('2026-09-14T00:00:00Z'),
    type: 'DRIVING_11',
    occurredAt: new Date('2026-09-14T10:00:00Z'),
    exceededBySec: 1560,
    detail: 'Driving 11h26m',
    status: 'OPEN',
    recalcVersion: 1,
    resolvedAt: null,
    resolvedById: null,
    resolutionNote: null,
    ...over,
    driver: { id: 'drv-1', firstName: 'John', lastName: 'Smith', assignedVehicleId: 'veh-2' },
  };
}

function setup(row: ViolationWithDriver | null = violation()) {
  const repo = {
    list: jest.fn().mockResolvedValue({ items: row ? [row] : [], total: row ? 1 : 0 }),
    findById: jest.fn().mockResolvedValue(row),
    resolveIfOpen: jest.fn().mockResolvedValue(true),
    findContextEvent: jest.fn().mockResolvedValue({ vehicleId: 'veh-1', locationName: 'Florence, KY' }),
    findVehicles: jest.fn().mockResolvedValue([{ id: 'veh-1', unitNumber: '101' }]),
  };
  const audit = { insert: jest.fn().mockResolvedValue({}) };
  const service = new ViolationsService(repo as unknown as ViolationsRepository, audit as unknown as AuditRepository);
  return { repo, audit, service };
}

describe('ViolationListQueryDto / buildWhere', () => {
  it('defaults to OPEN, page 1, limit 25', () => {
    const q = ViolationListQueryDto.parse({});
    expect(q).toMatchObject({ status: 'OPEN', page: 1, limit: 25 });
    expect(buildWhere(q, NOW)).toEqual({ status: 'OPEN' });
  });

  it('window=24h filters occurredAt to the last 24 hours', () => {
    const where = buildWhere(ViolationListQueryDto.parse({ window: '24h' }), NOW);
    expect(where.occurredAt).toEqual({ gte: new Date('2026-09-13T12:00:00Z') });
  });

  it('explicit from/to wins over window; status=ALL drops the status filter', () => {
    const q = ViolationListQueryDto.parse({ window: '24h', from: '2026-09-01', to: '2026-09-05', status: 'ALL', driverId: '6f1c1d9e-8a8b-4c1e-9d0a-1b2c3d4e5f60' });
    const where = buildWhere(q, NOW);
    expect(where.status).toBeUndefined();
    expect(where.occurredAt).toEqual({ gte: new Date('2026-09-01'), lte: new Date('2026-09-05') });
    expect(where.driverId).toBe('6f1c1d9e-8a8b-4c1e-9d0a-1b2c3d4e5f60');
  });

  it('rejects an unknown window, from after to, and limit over 200', () => {
    expect(ViolationListQueryDto.safeParse({ window: '1y' }).success).toBe(false);
    expect(ViolationListQueryDto.safeParse({ from: '2026-09-05', to: '2026-09-01' }).success).toBe(false);
    expect(ViolationListQueryDto.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('resolutionNote is 4-60 characters after trim', () => {
    expect(ResolveViolationDto.safeParse({ resolutionNote: ' ab ' }).success).toBe(false);
    expect(ResolveViolationDto.safeParse({ resolutionNote: 'x'.repeat(61) }).success).toBe(false);
    expect(ResolveViolationDto.safeParse({ resolutionNote: 'Adverse weather' }).success).toBe(true);
    expect(ResolveViolationDto.safeParse({}).success).toBe(false);
  });
});

describe('ViolationsService.list', () => {
  it('returns the paged envelope with driver name, unit from the RODS context event, location and label', async () => {
    const { service, repo } = setup();
    const result = await service.list(ViolationListQueryDto.parse({ window: '24h' }), NOW);
    expect(repo.findContextEvent).toHaveBeenCalledWith('drv-1', new Date('2026-09-14T10:00:00Z'));
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          id: 'vio-1',
          logDate: '2026-09-14',
          date: '2026-09-14',
          status: 'OPEN',
          severity: 'VIOLATION',
          driverName: 'John Smith',
          vehicleId: 'veh-1',
          unitNumber: '101',
          event: '11-hour driving limit exceeded',
          locationLabel: 'Florence, KY',
          occurredAt: '2026-09-14T10:00:00.000Z',
          resolvedAt: null,
        }),
      ],
      total: 1,
      page: 1,
      limit: 25,
      totalPages: 1,
    });
  });

  it('falls back to the driver assigned vehicle when no RODS event precedes the violation', async () => {
    const { service, repo } = setup();
    repo.findContextEvent.mockResolvedValue(null);
    repo.findVehicles.mockResolvedValue([{ id: 'veh-2', unitNumber: '202' }]);
    const result = await service.list(ViolationListQueryDto.parse({}), NOW);
    expect(result.items[0]).toMatchObject({ vehicleId: 'veh-2', unitNumber: '202', locationLabel: null });
  });
});

describe('ViolationsService.resolve', () => {
  it('resolves an OPEN row, writes VIOLATION_RESOLVED to the audit log and returns the §20 shape', async () => {
    const { service, repo, audit } = setup();
    const result = await service.resolve('vio-1', { resolutionNote: 'Adverse weather' }, ACTOR);

    expect(result).toMatchObject({ id: 'vio-1', status: 'RESOLVED', resolutionNote: 'Adverse weather' });
    expect(Number.isNaN(Date.parse(result.resolvedAt))).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['id', 'resolutionNote', 'resolvedAt', 'status']);
    expect(repo.resolveIfOpen).toHaveBeenCalledWith('vio-1', expect.objectContaining({ resolvedById: 'usr-1', resolutionNote: 'Adverse weather' }));
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'VIOLATION_RESOLVED', objectType: 'HosViolation', objectId: 'vio-1', actorId: 'usr-1' }),
    );
  });

  it('never touches RODS records: the repository exposes no EldEvent/DailyLog write', async () => {
    const { service, repo } = setup();
    await service.resolve('vio-1', { resolutionNote: 'Adverse weather' }, ACTOR);
    const called = Object.entries(repo).filter(([, fn]) => fn.mock.calls.length).map(([name]) => name);
    expect(called.sort()).toEqual(['findById', 'resolveIfOpen']);
  });

  it('404 for an unknown id', async () => {
    const { service, audit } = setup(null);
    await expect(service.resolve('nope', { resolutionNote: 'Adverse weather' }, ACTOR)).rejects.toMatchObject({ status: 404 });
    expect(audit.insert).not.toHaveBeenCalled();
  });

  it.each(['RESOLVED', 'AUTO_CLEARED'] as const)('409 when the row is already %s, no audit', async (status) => {
    const { service, repo, audit } = setup(violation({ status }));
    await expect(service.resolve('vio-1', { resolutionNote: 'Adverse weather' }, ACTOR)).rejects.toMatchObject({ status: 409 });
    expect(repo.resolveIfOpen).not.toHaveBeenCalled();
    expect(audit.insert).not.toHaveBeenCalled();
  });

  it('409 when a concurrent resolve wins the conditional update, no audit', async () => {
    const { service, repo, audit } = setup();
    repo.resolveIfOpen.mockResolvedValue(false);
    await expect(service.resolve('vio-1', { resolutionNote: 'Adverse weather' }, ACTOR)).rejects.toMatchObject({ status: 409 });
    expect(audit.insert).not.toHaveBeenCalled();
  });
});
