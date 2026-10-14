import { CompleteMaintenanceDto, CreateMaintenanceScheduleDto, DvirComplianceQueryDto, UpdateMaintenanceScheduleDto } from './service.dto';

describe('maintenance schedule DTOs (BE-008 / BE-021)', () => {
  const base = { vehicleId: '11111111-1111-4111-8111-111111111111', name: 'Oil', intervalMi: 25_000 };
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

  it('rejects a last service date in the future, accepts a past one', () => {
    expect(CreateMaintenanceScheduleDto.safeParse({ ...base, lastServiceAt: future }).success).toBe(false);
    expect(UpdateMaintenanceScheduleDto.safeParse({ lastServiceAt: future }).success).toBe(false);
    expect(CompleteMaintenanceDto.safeParse({ serviceAt: future }).success).toBe(false);
    expect(CreateMaintenanceScheduleDto.safeParse({ ...base, lastServiceAt: past }).success).toBe(true);
    expect(UpdateMaintenanceScheduleDto.safeParse({ lastServiceAt: past }).success).toBe(true);
  });

  it('caps odometer readings below INT4 overflow', () => {
    expect(CreateMaintenanceScheduleDto.safeParse({ ...base, lastServiceMi: 2_147_483_648 }).success).toBe(false);
    expect(UpdateMaintenanceScheduleDto.safeParse({ lastServiceMi: 2_147_483_648 }).success).toBe(false);
    expect(CompleteMaintenanceDto.safeParse({ serviceOdometerMi: 2_147_483_648 }).success).toBe(false);
    expect(CompleteMaintenanceDto.safeParse({ serviceOdometerMi: 450_000 }).success).toBe(true);
  });
});

describe('DvirComplianceQueryDto (CODE-074)', () => {
  it('refuses from after to', () => {
    expect(DvirComplianceQueryDto.safeParse({ from: '2026-09-21', to: '2026-09-20' }).success).toBe(false);
  });

  it('refuses a window over 366 days instead of silently cutting it', () => {
    expect(DvirComplianceQueryDto.safeParse({ from: '2025-01-01', to: '2026-01-01' }).success).toBe(true);
    expect(DvirComplianceQueryDto.safeParse({ from: '2025-01-01', to: '2026-01-02' }).success).toBe(false);
  });
});
