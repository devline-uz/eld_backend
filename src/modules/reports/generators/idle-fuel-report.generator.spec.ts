jest.mock('../lib/pdf-render', () => ({
  renderPdf: jest.fn(async (_name: string, data: Record<string, unknown>) => Buffer.from(JSON.stringify(data))),
}));

import { IdleFuelReportGenerator } from './idle-fuel-report.generator';
import { renderPdf } from '../lib/pdf-render';

/** B-14 — `IDLE_FUEL` reads `TelemetryPoint` as cumulative counters, so a day's idle
 * time/fuel is `MAX - MIN` over that day's points, never a raw sum. */
describe('IdleFuelReportGenerator', () => {
  function makeGenerator(queryRawRows: unknown[]) {
    const prisma = {
      $queryRaw: jest.fn(async () => queryRawRows),
      driver: { findMany: jest.fn(async () => [{ id: 'drv_1', firstName: 'John', lastName: 'Smith' }]) },
    };
    const generator = new IdleFuelReportGenerator(prisma as never);
    return { generator, prisma };
  }

  it('computes idle hours/fuel as the per-day delta and resolves driver names', async () => {
    const { generator } = makeGenerator([
      {
        vehicleId: 'veh_1',
        unitNumber: '101',
        driverId: 'drv_1',
        day: new Date('2026-09-10T00:00:00.000Z'),
        idleDeltaHours: 2.5,
        fuelIdleDeltaGal: 3.1,
      },
    ]);

    const rows = await generator.rows({ from: '2026-09-10', to: '2026-09-10' });

    expect(rows).toEqual([
      {
        vehicleId: 'veh_1',
        unitNumber: '101',
        driverId: 'drv_1',
        driverName: 'Smith, John',
        date: '2026-09-10',
        idleHours: 2.5,
        fuelIdleGal: 3.1,
      },
    ]);
  });

  it('never reports a negative delta (a counter reset mid-day floors at 0)', async () => {
    const { generator } = makeGenerator([
      { vehicleId: 'veh_1', unitNumber: '101', driverId: null, day: new Date('2026-09-10T00:00:00.000Z'), idleDeltaHours: -1, fuelIdleDeltaGal: -2 },
    ]);

    const rows = await generator.rows({ from: '2026-09-10', to: '2026-09-10' });
    expect(rows[0].idleHours).toBe(0);
    expect(rows[0].fuelIdleGal).toBe(0);
    expect(rows[0].driverName).toBe('—');
  });

  it('renders totals across all rows into the PDF template', async () => {
    const { generator } = makeGenerator([
      { vehicleId: 'veh_1', unitNumber: '101', driverId: 'drv_1', day: new Date('2026-09-10T00:00:00.000Z'), idleDeltaHours: 2, fuelIdleDeltaGal: 1 },
      { vehicleId: 'veh_1', unitNumber: '101', driverId: 'drv_1', day: new Date('2026-09-11T00:00:00.000Z'), idleDeltaHours: 3, fuelIdleDeltaGal: 1.5 },
    ]);

    const { rowCount } = await generator.pdf({ from: '2026-09-10', to: '2026-09-11' });
    expect(rowCount).toBe(2);
    const [, data] = (renderPdf as jest.Mock).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(data.totalIdleHours).toBe('5.00');
    expect(data.totalFuelIdleGal).toBe('2.50');
  });
});
