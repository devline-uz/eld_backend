import { FmcsaPackGenerator } from './fmcsa-pack.generator';

jest.mock('../lib/pdf-render', () => ({
  renderPdf: jest.fn(async (_name: string, data: Record<string, unknown>) => Buffer.from(JSON.stringify(data))),
}));
jest.mock('../../transfers/snapshot', () => ({
  buildSnapshot: jest.fn(() => ({})),
  activeMalfunctionCodes: jest.fn(() => []),
  uncertifiedDayCount: jest.fn(() => 0),
}));
jest.mock('../../transfers/output-file', () => ({
  buildOutputFile: jest.fn(() => ({ csv: 'CSV-BYTES' })),
}));
jest.mock('../../transfers/validator', () => ({
  validateOutputFile: jest.fn(() => ({ valid: true, issues: [] })),
}));

import { renderPdf } from '../lib/pdf-render';

const CARRIER = {
  id: 'carrier',
  name: 'OneBook Logistics',
  dotNumber: '3355123',
  timezone: 'America/New_York',
  eldIdentifier: 'OBK1',
  eldRegistrationId: 'OBK1',
  erodsMode: 'PRODUCTION',
};

function makeDriver(id: string, first: string, last: string) {
  return { id, firstName: first, lastName: last, cdlNumber: `CDL-${id}`, homeTerminalTimezone: null };
}

function makeEvent(vehicleId: string, driverId: string) {
  return { id: BigInt(1), vehicleId, driverId, editedById: null, eventType: 1, eventCode: 1 };
}

/**
 * B-48 — `FmcsaPackParamsDto.vehicleId`/`include[]` must really change the pack's contents;
 * no `include` still yields the full pack (acceptance criterion, tasks.md Phase 13D). Pure
 * §395 Appendix A generation (`buildSnapshot`/`buildOutputFile`/`validateOutputFile`) is
 * mocked out here — those are covered by `transfers/*.spec.ts` — so this asserts only the
 * gap this phase closes: which drivers are in the pack and what the cover PDF/entries carry.
 */
describe('FmcsaPackGenerator', () => {
  function makeGenerator(overrides: { events?: Record<string, ReturnType<typeof makeEvent>[]> } = {}) {
    const drivers = [makeDriver('d1', 'John', 'Smith'), makeDriver('d2', 'Ana', 'Ortiz')];
    const eventsByDriver = overrides.events ?? {
      d1: [makeEvent('veh-A', 'd1')],
      d2: [makeEvent('veh-B', 'd2')],
    };

    const prisma = {
      driver: { findMany: jest.fn(async () => drivers) },
      defect: { count: jest.fn(async () => 2) },
    };
    const transfers = {
      findCarrier: jest.fn(async () => CARRIER),
      findEvents: jest.fn(async (driverId: string) => eventsByDriver[driverId] ?? []),
      findUnidentifiedEvents: jest.fn(async () => []),
      findDailyLogs: jest.fn(async () => []),
      findPendingUnidentifiedSegments: jest.fn(async () => []),
      findVehicles: jest.fn(async () => []),
      findUsers: jest.fn(async () => []),
    };
    const storage = { put: jest.fn(async (key: string) => key) };

    const generator = new FmcsaPackGenerator(prisma as never, transfers as never, storage as never);
    return { generator, prisma, transfers, storage };
  }

  it('includes every active driver and generates the RODS output file when include is omitted (full pack)', async () => {
    const { generator, storage } = makeGenerator();
    const result = await generator.build({ from: '2026-09-01', to: '2026-09-03', include: undefined }, 'rpt1');

    expect(result.driverEntries).toHaveLength(2);
    expect(result.driverEntries.every((e) => e.status === 'INCLUDED')).toBe(true);
    expect(result.driverEntries.every((e) => e.fileKey)).toBe(true);
    expect(storage.put).toHaveBeenCalledTimes(2);
  });

  it('vehicleId filters the pack to only drivers who operated that unit in the period', async () => {
    const { generator } = makeGenerator();
    const result = await generator.build({ from: '2026-09-01', to: '2026-09-03', vehicleId: 'veh-A' }, 'rpt1');

    expect(result.driverEntries).toHaveLength(1);
    expect(result.driverEntries[0].driverId).toBe('d1');
  });

  it('include without RODS skips generating/storing the Appendix A file but keeps the cover row', async () => {
    const { generator, storage } = makeGenerator();
    const result = await generator.build(
      { from: '2026-09-01', to: '2026-09-03', include: ['DVIR', 'MALFUNCTIONS'] } as never,
      'rpt1',
    );

    expect(result.driverEntries).toHaveLength(2);
    expect(result.driverEntries.every((e) => e.status === 'INCLUDED')).toBe(true);
    expect(result.driverEntries.every((e) => e.fileKey === undefined)).toBe(true);
    expect(storage.put).not.toHaveBeenCalled();
    expect(result.driverEntries.every((e) => typeof e.dvirOpenDefects === 'number')).toBe(true);
  });

  it('include without DVIR/UNIDENTIFIED/EDITS omits those computed fields', async () => {
    const { generator } = makeGenerator();
    const result = await generator.build({ from: '2026-09-01', to: '2026-09-03', include: ['RODS'] } as never, 'rpt1');

    expect(result.driverEntries[0].dvirOpenDefects).toBeUndefined();
    expect(result.driverEntries[0].unidentifiedCount).toBeUndefined();
    expect(result.driverEntries[0].editCount).toBeUndefined();
  });

  it('renders the cover PDF with the unit filter and include list so the pack visibly reflects the request', async () => {
    const { generator } = makeGenerator();
    await generator.build({ from: '2026-09-01', to: '2026-09-03', vehicleId: 'veh-A', include: ['RODS', 'DVIR'] } as never, 'rpt1');

    const calls = (renderPdf as jest.Mock).mock.calls as [string, { unitFilter: string; includeLabel: string }][];
    const call = calls[calls.length - 1];
    expect(call[0]).toBe('fmcsa-pack');
    expect(call[1].unitFilter).toBe('veh-A');
    expect(call[1].includeLabel).toBe('RODS, DVIR');
  });
});
