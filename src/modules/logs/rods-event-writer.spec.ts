/** TZ §5.5 / §7.3 rule 8 — appended RODS records are sequenced, partitioned and checksummed. */
import { EditorType } from '@prisma/client';
import type { IngestRepository } from '../ingest/ingest.repository';
import { computeChecksum, type ChecksumFields } from '../ingest/checksum';
import type { AppendRow } from './edit-plan';
import { RodsEventWriter } from './rods-event-writer';

class FakeIngestRepo {
  inserted: Array<Record<string, unknown>> = [];
  allocateSequenceIds = jest.fn(async (_tx: unknown, _key: string, count: number) =>
    Array.from({ length: count }, (_v, index) => 500 + index),
  );
  ensurePartitions = jest.fn(async () => undefined);
  insertEvents = jest.fn(async (_tx: unknown, rows: Array<Record<string, unknown>>) => {
    this.inserted.push(...rows);
    return rows.length;
  });
}

function tx(repo: FakeIngestRepo) {
  return {
    eldEvent: {
      findMany: jest.fn(async () =>
        repo.inserted.map((row, index) => ({ id: BigInt(900 + index), uuid: row.uuid as string })),
      ),
    },
  };
}

const rows: AppendRow[] = [
  {
    kind: 'NEW_ACTIVE',
    eventType: 1,
    eventCode: 4,
    at: new Date('2026-06-01T18:00:00Z'),
    recordStatus: 1,
    recordOrigin: 2,
    supersedesId: null,
    annotation: 'Loading at shipper #4821',
  },
  {
    kind: 'INACTIVE_MARKER',
    eventType: 1,
    eventCode: 1,
    at: new Date('2026-06-01T12:00:00Z'),
    recordStatus: 2,
    recordOrigin: 2,
    supersedesId: 7n,
    annotation: 'Loading at shipper #4821',
  },
];

const ctx = {
  driverId: 'driver-1',
  sequenceKey: 'driver-1',
  timezone: 'America/New_York',
  vehicleId: 'veh-1',
  editedById: 'driver-1',
  editorType: EditorType.DRIVER,
};

describe('RodsEventWriter', () => {
  it('allocates sequence ids chronologically and never reuses the ingest path twice', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);

    await writer.append(tx(repo) as never, ctx, rows);

    expect(repo.allocateSequenceIds).toHaveBeenCalledWith(expect.anything(), 'driver-1', 2);
    // The earlier record (12:00) gets the lower sequence id.
    const marker = repo.inserted.find((row) => row.recordStatus === 2);
    const active = repo.inserted.find((row) => row.recordStatus === 1);
    expect(marker!.eventSequenceId).toBe(500);
    expect(active!.eventSequenceId).toBe(501);
  });

  it('checksums every appended record the same way ingest does (§23)', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);

    await writer.append(tx(repo) as never, ctx, rows);

    for (const row of repo.inserted) {
      expect(row.checksum).toBe(
        computeChecksum({
          uuid: row.uuid as string,
          eventType: row.eventType as number,
          eventCode: row.eventCode as number,
          eventDateTime: row.eventDateTime as Date,
          timezoneOffset: row.timezoneOffset as number,
          recordStatus: row.recordStatus as number,
          recordOrigin: row.recordOrigin as number,
          latitude: null,
          longitude: null,
          rawDeviceOdometerKm: null,
          totalEngineHours: null,
        }),
      );
    }
  });

  it('records the home terminal offset in minutes and ensures the month partition', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);

    await writer.append(tx(repo) as never, ctx, rows);

    expect(repo.ensurePartitions).toHaveBeenCalledWith(expect.anything(), ['2026-06-01']);
    expect(repo.inserted[0].timezoneOffset).toBe(-240); // EDT
  });

  it('coarsens a personal-conveyance position to 10 miles before storage (§23)', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);

    await writer.append(
      tx(repo) as never,
      { ...ctx, personalConveyance: true, location: { lat: 38.999123, lon: -84.626456 } },
      [rows[0]],
    );

    expect(repo.inserted[0].locationPrecisionMi).toBe(10);
    expect(Math.abs((repo.inserted[0].latitude as number) - 38.999123)).toBeGreaterThan(0);
  });

  it('B-39: stores a name-only location with no coordinates', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);

    await writer.append(tx(repo) as never, { ...ctx, location: { name: 'Acme yard, Dayton OH' } }, [rows[0]]);

    expect(repo.inserted[0]).toMatchObject({ latitude: null, longitude: null, locationName: 'Acme yard, Dayton OH' });
  });

  it('B-72: writes the engine hours and checksums them', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);

    await writer.append(tx(repo) as never, { ...ctx, totalEngineHours: 4321.4 }, [rows[0]]);

    const row = repo.inserted[0];
    expect(row.totalEngineHours).toBe(4321.4);
    const withoutHours = computeChecksum({ ...(row as unknown as ChecksumFields), totalEngineHours: null });
    expect(row.checksum).not.toBe(withoutHours);
  });

  it('returns ids keyed by the CALLER\'s row order, not the chronological one', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);

    const ids = await writer.append(tx(repo) as never, ctx, rows);

    expect([...ids.keys()].sort()).toEqual(['INACTIVE_MARKER:1', 'NEW_ACTIVE:0']);
  });

  it('§395 App. A 4.4.2 — a position without a name gets the offline geo-location text', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);
    await writer.append(tx(repo) as never, { ...ctx, location: { lat: 39.961, lon: -83.063 } }, [rows[0]]);
    expect(repo.inserted[0].locationName).toMatch(/^\d{1,2}mi [NSEW]{1,3} OH \S/);
  });

  it('a supplied location name wins over the computed one', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);
    await writer.append(tx(repo) as never, { ...ctx, location: { lat: 39.961, lon: -83.063, name: 'Shipper #4821' } }, [rows[0]]);
    expect(repo.inserted[0].locationName).toBe('Shipper #4821');
  });

  it('personal conveyance describes the 10-mile position in 10-mile distance steps', async () => {
    const repo = new FakeIngestRepo();
    const writer = new RodsEventWriter(repo as unknown as IngestRepository);
    await writer.append(tx(repo) as never, { ...ctx, personalConveyance: true, location: { lat: 39.961, lon: -83.063 } }, [rows[0]]);
    expect(repo.inserted[0].locationName).toMatch(/^((\d)?0mi [NSEW]{1,3} )?OH \S/);
  });
});
