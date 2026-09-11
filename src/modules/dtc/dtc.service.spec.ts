import type { TelemetryPointDto } from '../ingest/dto/ingest.dto';
import { DtcRepository } from './dtc.repository';
import { DtcService } from './dtc.service';

function point(overrides: Partial<TelemetryPointDto> = {}): TelemetryPointDto {
  return {
    time: new Date('2026-09-11T12:00:00.000Z'),
    latitude: 40,
    longitude: -83,
    isTransition: false,
    ...overrides,
  } as TelemetryPointDto;
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

    expect(repo.bumpOccurrence).toHaveBeenCalledWith('dtc_1', expect.any(Date));
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
});
