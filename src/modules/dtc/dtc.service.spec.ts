import type { TelemetryPointDto } from '../ingest/dto/ingest.dto';
import { DtcRepository } from './dtc.repository';
import { DtcService, normaliseDtc } from './dtc.service';

function point(overrides: Partial<TelemetryPointDto> = {}): TelemetryPointDto {
  return {
    time: new Date('2026-09-11T12:00:00.000Z'),
    latitude: 40,
    longitude: -83,
    isTransition: false,
    ...overrides,
  };
}

describe('DtcService (TZ §5.7 — DTC capture from the ingest path)', () => {
  let repo: jest.Mocked<Pick<DtcRepository, 'findOpenByCode' | 'bumpOccurrence' | 'create' | 'listForVehicle' | 'clearAllOpen'>>;
  let service: DtcService;

  beforeEach(() => {
    repo = {
      findOpenByCode: jest.fn(),
      bumpOccurrence: jest.fn(),
      create: jest.fn(),
      listForVehicle: jest.fn(),
      clearAllOpen: jest.fn(),
    };
    service = new DtcService(repo as unknown as DtcRepository);
  });

  it('creates a new DTC row for a code with no currently-open match', async () => {
    repo.findOpenByCode.mockResolvedValue(null);
    await service.captureFromPoints('veh_1', [point({ dtcCodes: [{ spn: 100, fmi: 1, source: '0', description: 'Oil pressure low' }] })]);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ vehicleId: 'veh_1', spn: 100, fmi: 1, occurrence: 1 }),
    );
  });

  it('bumps occurrence instead of duplicating when the code is already open', async () => {
    repo.findOpenByCode.mockResolvedValue({ id: 'dtc_1' } as never);
    await service.captureFromPoints('veh_1', [point({ dtcCodes: [{ spn: 100, fmi: 1 }] })]);

    expect(repo.bumpOccurrence).toHaveBeenCalledWith('dtc_1', expect.any(Date), { bus: 'J1939' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('clears every open code when a point reports dtcCount: 0', async () => {
    await service.captureFromPoints('veh_1', [point({ dtcCount: 0 })]);
    expect(repo.clearAllOpen).toHaveBeenCalledWith('veh_1', expect.any(Date));
  });

  it('does nothing for a point with neither dtcCodes nor dtcCount: 0', async () => {
    await service.captureFromPoints('veh_1', [point()]);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.clearAllOpen).not.toHaveBeenCalled();
  });

  it('never throws — a capture failure must not fail the telemetry write it rides on', async () => {
    repo.findOpenByCode.mockRejectedValue(new Error('db down'));
    await expect(
      service.captureFromPoints('veh_1', [point({ dtcCodes: [{ spn: 1, fmi: 1 }] })]),
    ).resolves.toBeUndefined();
  });

  describe('PT SDK 6.11 — bus-specific dedupe (D-135)', () => {
    it('J1939 dedupes on (spn, fmi) and stores bus / MIL / conversion method', async () => {
      repo.findOpenByCode.mockResolvedValue(null);
      await service.captureFromPoints('veh_1', [
        point({ busType: 'J1939', milOn: true, dtcCodes: [{ spn: 100, fmi: 1, occurrence: 4, conversionMethod: 0 }] }),
      ]);
      expect(repo.findOpenByCode).toHaveBeenCalledWith('veh_1', { spn: 100, fmi: 1, code: null });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ spn: 100, fmi: 1, code: null, bus: 'J1939', milOn: true, conversionMethod: 0, occurrence: 4 }),
      );
    });

    it('J1708 dedupes on (SID/PID label, fmi) built from spn + isSid', async () => {
      repo.findOpenByCode.mockResolvedValue(null);
      await service.captureFromPoints('veh_1', [point({ dtcCodes: [{ spn: 254, isSid: true, fmi: 3, bus: 'J1708', active: true }] })]);
      expect(repo.findOpenByCode).toHaveBeenCalledWith('veh_1', { spn: null, fmi: 3, code: 'SID 254' });
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'SID 254', bus: 'J1708', active: true }));
    });

    it('OBD-II dedupes on the code alone', async () => {
      repo.findOpenByCode.mockResolvedValue(null);
      await service.captureFromPoints('veh_1', [point({ busType: 'OBD_II', dtcCodes: [{ code: 'p0301', fmi: 2 }] })]);
      expect(repo.findOpenByCode).toHaveBeenCalledWith('veh_1', { spn: null, fmi: null, code: 'P0301' });
    });

    it('a repeat takes the device occurrence count (never lowered) and the latest MIL state', async () => {
      repo.findOpenByCode.mockResolvedValue({ id: 'dtc_1', occurrence: 6, lastSeenAt: new Date('2026-09-11T13:00:00Z') } as never);
      await service.captureFromPoints('veh_1', [point({ milOn: false, dtcCodes: [{ spn: 100, fmi: 1, occurrence: 4 }] })]);
      // Late point (12:00) must not move lastSeenAt back from 13:00.
      expect(repo.bumpOccurrence).toHaveBeenCalledWith('dtc_1', new Date('2026-09-11T13:00:00Z'), {
        occurrence: 6,
        bus: 'J1939',
        milOn: false,
      });
    });

    it('normaliseDtc: a code without SPN and no bus reads as OBD-II; an SPN as J1939', () => {
      expect(normaliseDtc({ code: 'P0420' }, null).bus).toBe('OBD_II');
      expect(normaliseDtc({ spn: 91, fmi: 2 }, null).bus).toBe('J1939');
      expect(normaliseDtc({ code: 'PID 84', fmi: 2 }, 'J1708').key).toEqual({ spn: null, fmi: 2, code: 'PID 84' });
    });
  });
});
