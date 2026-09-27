jest.mock('../lib/pdf-render', () => ({
  renderPdf: jest.fn(async (_name: string, data: Record<string, unknown>) => Buffer.from(JSON.stringify(data))),
}));

import { RodsReportGenerator } from './rods-report.generator';
import { renderPdf } from '../lib/pdf-render';

/** B-14 — `RODS`: one printable page per driver per day, reusing `LogsService.getRange`/
 * `getEvents` so the printed sheet can never disagree with the online RODS view. */
describe('RodsReportGenerator', () => {
  function makeGenerator() {
    const findMany = jest.fn<
      Promise<{ id: string; firstName: string; lastName: string; cdlNumber: string }[]>,
      [{ where: { id?: string } }]
    >(async () => [{ id: 'drv_1', firstName: 'John', lastName: 'Smith', cdlNumber: 'CDL-1' }]);
    const prisma = { driver: { findMany } };
    const logs = {
      getRange: jest.fn(async () => ({
        days: [
          { date: '2026-09-10', timezone: 'America/New_York', offDutySec: 36000, sleeperSec: 0, drivingSec: 28800, onDutySec: 7200, totalDistanceMi: 412, certified: true },
        ],
      })),
      getEvents: jest.fn(async () => ({
        events: [{ eventDateTime: new Date('2026-09-10T13:00:00Z'), status: 'D', locationName: 'New Haven, CT', totalVehicleMiles: 993107 }],
      })),
    };
    return { generator: new RodsReportGenerator(prisma as never, logs as never), prisma, logs };
  }

  it('builds one page per driver-day with hours converted from seconds', async () => {
    const { generator } = makeGenerator();
    const { rowCount } = await generator.pdf({ from: '2026-09-10', to: '2026-09-10' });

    expect(rowCount).toBe(1);
    const [, data] = (renderPdf as jest.Mock).mock.calls.at(-1) as [string, { pages: Array<Record<string, unknown>> }];
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0]).toMatchObject({
      driverName: 'Smith, John',
      date: '2026-09-10',
      drivingHours: '8.00',
      onDutyHours: '2.00',
      offDutyHours: '10.00',
    });
    expect(String(data.pages[0].eventLines)).toContain('New Haven, CT');
  });

  it('filters to one driver when driverId is given', async () => {
    const { generator, prisma } = makeGenerator();
    await generator.pdf({ from: '2026-09-10', to: '2026-09-10', driverId: 'drv_1' });
    const call = prisma.driver.findMany.mock.calls[0][0];
    expect(call.where.id).toBe('drv_1');
  });
});
