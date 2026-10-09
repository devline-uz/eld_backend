/** TZ §13.4/13.6 — `POST /mobile/sync`: idempotent replay, rejection persistence, batch limits. */
import type { SyncedChange } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import type { EventBusService } from '../../core/events/event-bus.service';
import type { LogsService } from '../logs/logs.service';
import type { SyncChangeDto, SyncRequestDto } from './dto/mobile.dto';
import type { MobileDvirService } from './mobile-dvir.service';
import { MobileSyncService } from './mobile-sync.service';
import type { MobileRepository } from './mobile.repository';
import type { SignatureService } from './signature.service';

const actor: ContextUser = { id: 'drv_1', type: 'driver' };
const NOW = new Date('2026-09-11T15:41:00.000Z');

function change(over: Partial<SyncChangeDto> = {}): SyncChangeDto {
  return {
    type: 'duty_status',
    clientId: 'client-1',
    occurredAt: NOW,
    payload: { status: 'OFF', startAt: NOW, annotation: 'Status change' },
    ...over,
  } as SyncChangeDto;
}

function syncedRow(over: Partial<SyncedChange> = {}): SyncedChange {
  return {
    id: 'sc_1',
    driverId: 'drv_1',
    clientId: 'client-1',
    type: 'duty_status',
    status: 'ACCEPTED',
    errorCode: null,
    result: null,
    occurredAt: NOW,
    processedAt: NOW,
    ...over,
  };
}

describe('MobileSyncService', () => {
  let repo: jest.Mocked<Pick<MobileRepository, 'findSyncedByClientId' | 'recordSyncedResult' | 'findEventsSince' | 'touchLastSync'>>;
  let logs: jest.Mocked<Pick<LogsService, 'createLogEntry' | 'certify'>>;
  let dvir: jest.Mocked<Pick<MobileDvirService, 'submit'>>;
  let signatures: jest.Mocked<Pick<SignatureService, 'store'>>;
  let events: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let alertQueue: { add: jest.Mock };
  let service: MobileSyncService;

  beforeEach(() => {
    repo = {
      findSyncedByClientId: jest.fn().mockResolvedValue(null),
      recordSyncedResult: jest
        .fn()
        .mockImplementation((_d: string, _c: string, _t: string, _o: Date, status: 'ACCEPTED' | 'REJECTED', errorCode: string | null) =>
          Promise.resolve({ status, errorCode }),
        ),
      findEventsSince: jest.fn().mockResolvedValue([]),
      touchLastSync: jest.fn().mockResolvedValue(undefined),
    };
    logs = { createLogEntry: jest.fn().mockResolvedValue({ id: 'evt_1' }), certify: jest.fn() };
    dvir = { submit: jest.fn() };
    signatures = { store: jest.fn().mockResolvedValue({ id: 'sig_offline', key: 'signatures/drv_1/sig_offline.png', sha256: 'x', sizeBytes: 4 }) };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    alertQueue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new MobileSyncService(
      repo as unknown as MobileRepository,
      logs as unknown as LogsService,
      dvir as unknown as MobileDvirService,
      signatures as unknown as SignatureService,
      events as unknown as EventBusService,
      alertQueue as never,
    );
  });

  it('applies a fresh duty_status change and accepts it', async () => {
    const dto: SyncRequestDto = { changes: [change()] };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.accepted).toEqual(['client-1']);
    expect(result.rejected).toEqual([]);
    expect(logs.createLogEntry).toHaveBeenCalledTimes(1);
    expect(repo.recordSyncedResult).toHaveBeenCalledWith('drv_1', 'client-1', 'duty_status', NOW, 'ACCEPTED', null, { id: 'evt_1' });
  });

  it('replaying the same clientId is idempotent — the underlying mutation is never re-applied', async () => {
    repo.findSyncedByClientId.mockResolvedValue(syncedRow());
    const dto: SyncRequestDto = { changes: [change()] };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.accepted).toEqual(['client-1']);
    expect(logs.createLogEntry).not.toHaveBeenCalled();
    expect(repo.recordSyncedResult).not.toHaveBeenCalled();
  });

  it('a rejected replay is remembered without re-running the mutation', async () => {
    repo.findSyncedByClientId.mockResolvedValue(syncedRow({ status: 'REJECTED', errorCode: ERROR_CODES.DRIVING_TIME_IMMUTABLE }));
    const dto: SyncRequestDto = { changes: [change()] };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.rejected).toEqual([{ clientId: 'client-1', code: ERROR_CODES.DRIVING_TIME_IMMUTABLE }]);
    expect(logs.createLogEntry).not.toHaveBeenCalled();
  });

  it('an AppException from the underlying service is caught, recorded and reported rejected', async () => {
    logs.createLogEntry.mockRejectedValue(new AppException(ERROR_CODES.DRIVING_TIME_IMMUTABLE, 'nope', 422));
    const dto: SyncRequestDto = { changes: [change()] };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.rejected).toEqual([{ clientId: 'client-1', code: ERROR_CODES.DRIVING_TIME_IMMUTABLE, message: 'nope' }]);
    expect(result.accepted).toEqual([]);
    expect(repo.recordSyncedResult).toHaveBeenCalledWith('drv_1', 'client-1', 'duty_status', NOW, 'REJECTED', ERROR_CODES.DRIVING_TIME_IMMUTABLE, undefined);
  });

  it('a non-AppException error is still recorded and never silently dropped', async () => {
    logs.createLogEntry.mockRejectedValue(new Error('db exploded'));
    const dto: SyncRequestDto = { changes: [change()] };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].clientId).toBe('client-1');
    expect(result.rejected[0].code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(typeof result.rejected[0].message).toBe('string');
  });

  it('when the ledger insert races and loses (DUPLICATE), the winner outcome is returned', async () => {
    repo.recordSyncedResult.mockResolvedValueOnce('DUPLICATE');
    repo.findSyncedByClientId.mockResolvedValueOnce(null).mockResolvedValueOnce(syncedRow({ status: 'ACCEPTED' }));
    const dto: SyncRequestDto = { changes: [change()] };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.accepted).toEqual(['client-1']);
  });

  it('looks the idempotency ledger up scoped to the syncing driver, never by clientId alone', async () => {
    const dto: SyncRequestDto = { changes: [change()] };
    await service.sync('drv_1', dto, actor, NOW);
    // Regression guard: an unscoped lookup let one driver burn a `clientId` and have another
    // driver's genuine queued HOS change silently skipped (bugs.md).
    expect(repo.findSyncedByClientId).toHaveBeenCalledWith('drv_1', 'client-1');
  });

  it('rejects a batch over 1 MB with SYNC_BATCH_TOO_LARGE', async () => {
    const big = change({ payload: { status: 'OFF', startAt: NOW, annotation: 'x'.repeat(2 * 1024 * 1024) } });
    const dto: SyncRequestDto = { changes: [big] };
    await expect(service.sync('drv_1', dto, actor, NOW)).rejects.toThrow(AppException);
  });

  it('dispatches certify and dvir change types to the right service', async () => {
    logs.certify.mockResolvedValue({ driverId: 'drv_1', days: [] });
    dvir.submit.mockResolvedValue({ id: 'dvir_1' } as never);
    const dto: SyncRequestDto = {
      changes: [
        change({ type: 'certify', clientId: 'c-certify', payload: { dates: ['2026-09-10'], signatureMimeType: 'image/png' } }),
        change({ type: 'dvir', clientId: 'c-dvir', payload: { vehicleId: 'veh_1' } as never }),
      ],
    };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.accepted.sort()).toEqual(['c-certify', 'c-dvir']);
    expect(logs.certify).toHaveBeenCalledWith({ dates: ['2026-09-10'], signatureImageId: undefined, driverId: undefined }, actor);
    expect(dvir.submit).toHaveBeenCalledWith('drv_1', { vehicleId: 'veh_1' }, actor);
  });

  it('MB-8 — an offline certify with signatureBase64 stores it via SignatureService before certifying', async () => {
    logs.certify.mockResolvedValue({ driverId: 'drv_1', days: [] });
    const dto: SyncRequestDto = {
      changes: [
        change({
          type: 'certify',
          clientId: 'c-certify-offline',
          payload: { dates: ['2026-09-10'], signatureBase64: 'x'.repeat(20), signatureMimeType: 'image/png' },
        }),
      ],
    };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.accepted).toEqual(['c-certify-offline']);
    expect(signatures.store).toHaveBeenCalledWith('signatures', 'drv_1', 'x'.repeat(20), 'image/png');
    expect(logs.certify).toHaveBeenCalledWith({ dates: ['2026-09-10'], signatureImageId: 'sig_offline', driverId: undefined }, actor);
  });

  it('MB-8 — an existing signatureImageId is never overwritten, even if signatureBase64 is also present', async () => {
    logs.certify.mockResolvedValue({ driverId: 'drv_1', days: [] });
    const dto: SyncRequestDto = {
      changes: [
        change({
          type: 'certify',
          clientId: 'c-certify-both',
          payload: { dates: ['2026-09-10'], signatureImageId: 'sig_existing', signatureBase64: 'x'.repeat(20), signatureMimeType: 'image/png' },
        }),
      ],
    };
    await service.sync('drv_1', dto, actor, NOW);
    expect(signatures.store).not.toHaveBeenCalled();
    expect(logs.certify).toHaveBeenCalledWith({ dates: ['2026-09-10'], signatureImageId: 'sig_existing', driverId: undefined }, actor);
  });

  it('processes changes in occurredAt order, not submission order', async () => {
    const order: string[] = [];
    logs.createLogEntry.mockImplementation((_driverId, payload) => {
      order.push(payload.annotation);
      return Promise.resolve({ id: 'evt' } as never);
    });
    const later = change({ clientId: 'later', occurredAt: new Date(NOW.getTime() + 60_000), payload: { status: 'OFF', startAt: NOW, annotation: 'later' } });
    const earlier = change({ clientId: 'earlier', occurredAt: new Date(NOW.getTime() - 60_000), payload: { status: 'OFF', startAt: NOW, annotation: 'earlier' } });
    await service.sync('drv_1', { changes: [later, earlier] }, actor, NOW);
    expect(order).toEqual(['earlier', 'later']);
  });

  it('MB-11 — raises alert.sync_backlog when the reported backlog exceeds the configured thresholds', async () => {
    await service.sync('drv_1', { changes: [], backlog: { days: 31, bytes: 0 } }, actor, NOW);
    expect(events.publish).toHaveBeenCalledWith('alert.sync_backlog', { driverId: 'drv_1', days: 31, bytes: 0 });
    expect(alertQueue.add).toHaveBeenCalledWith('alert.sync_backlog', { driverId: 'drv_1', days: 31, bytes: 0 });
  });

  it('MB-11 — a backlog within thresholds raises nothing', async () => {
    await service.sync('drv_1', { changes: [], backlog: { days: 1, bytes: 100 } }, actor, NOW);
    expect(events.publish).not.toHaveBeenCalledWith('alert.sync_backlog', expect.anything());
  });

  it('MB-11 — the alert is raised only once per driver per day', async () => {
    await service.sync('drv_1', { changes: [], backlog: { days: 31, bytes: 0 } }, actor, NOW);
    await service.sync('drv_1', { changes: [], backlog: { days: 32, bytes: 0 } }, actor, NOW);
    expect(events.publish.mock.calls.filter((c) => c[0] === 'alert.sync_backlog')).toHaveLength(1);
  });

  describe('MR-25 — shared tablet: driverId on a change', () => {
    const CO = '2b7f5c1e-8d4a-4c3b-9e2f-1a0b9c8d7e6f';
    let fullRepo: Record<string, jest.Mock>;
    let audit: { insert: jest.Mock };

    beforeEach(() => {
      fullRepo = repo as unknown as Record<string, jest.Mock>;
      fullRepo.findDriver = jest.fn().mockResolvedValue({ id: CO, status: 'ACTIVE', deletedAt: null });
      fullRepo.findPairingCovering = jest.fn().mockResolvedValue({ id: 'pair_1', vehicleId: 'veh_1' });
      fullRepo.findLoginVehicleAt = jest.fn().mockResolvedValue(null);
      audit = { insert: jest.fn().mockResolvedValue(undefined) };
      service = new MobileSyncService(
        repo as unknown as MobileRepository,
        logs as unknown as LogsService,
        dvir as unknown as MobileDvirService,
        signatures as unknown as SignatureService,
        events as unknown as EventBusService,
        alertQueue as never,
        audit as never,
      );
    });

    it('applies the change to the co-driver paired on the same unit at occurredAt, and audits it', async () => {
      const result = await service.sync('drv_1', { changes: [change({ driverId: CO })] }, actor, NOW);
      expect(result.accepted).toEqual(['client-1']);
      expect(fullRepo.findPairingCovering).toHaveBeenCalledWith('drv_1', CO, NOW);
      expect(logs.createLogEntry).toHaveBeenCalledWith(CO, expect.anything(), actor);
      expect(audit.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SYNC_DELEGATED_CHANGE', actorId: 'drv_1', objectId: CO }),
      );
    });

    it('rejects only that change when there was no shared pairing at that time', async () => {
      fullRepo.findPairingCovering.mockResolvedValue(null);
      const result = await service.sync(
        'drv_1',
        { changes: [change({ driverId: CO }), change({ clientId: 'client-2', occurredAt: new Date(NOW.getTime() + 1000) })] },
        actor,
        NOW,
      );
      expect(result.rejected).toEqual([expect.objectContaining({ clientId: 'client-1', code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED })]);
      expect(result.accepted).toEqual(['client-2']);
      expect(logs.createLogEntry).toHaveBeenCalledTimes(1);
      expect(logs.createLogEntry).toHaveBeenCalledWith('drv_1', expect.anything(), actor);
    });

    it('rejects an unknown / inactive driver and never delegates certification', async () => {
      fullRepo.findDriver.mockResolvedValue(null);
      const unknown = await service.sync('drv_1', { changes: [change({ driverId: CO })] }, actor, NOW);
      expect(unknown.rejected[0]).toMatchObject({ code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });

      fullRepo.findDriver.mockResolvedValue({ id: CO, status: 'ACTIVE', deletedAt: null });
      const certify = await service.sync(
        'drv_1',
        { changes: [change({ type: 'certify', clientId: 'client-9', driverId: CO, payload: { dates: ['2026-09-10'], signatureMimeType: 'image/png' } })] },
        actor,
        NOW,
      );
      expect(certify.rejected[0]).toMatchObject({ clientId: 'client-9', code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });
      expect(logs.certify).not.toHaveBeenCalled();
    });

    it('without a pairing, accepts when both drivers were logged in (eventType 5) to the same unit at occurredAt', async () => {
      fullRepo.findPairingCovering.mockResolvedValue(null);
      fullRepo.findLoginVehicleAt.mockImplementation(async () => 'veh_7');
      const result = await service.sync('drv_1', { changes: [change({ driverId: CO })] }, actor, NOW);
      expect(result.accepted).toEqual(['client-1']);
      expect(fullRepo.findLoginVehicleAt).toHaveBeenCalledWith('drv_1', NOW);
      expect(fullRepo.findLoginVehicleAt).toHaveBeenCalledWith(CO, NOW);
      const [[auditRow]] = audit.insert.mock.calls as Array<[{ after: Record<string, unknown> }]>;
      expect(auditRow.after).toMatchObject({ vehicleId: 'veh_7', evidence: 'ELD_LOGIN_SESSION', pairingId: null });
    });

    it('rejects when the two drivers were logged in to different units', async () => {
      fullRepo.findPairingCovering.mockResolvedValue(null);
      fullRepo.findLoginVehicleAt.mockImplementation(async (id: string) => (id === CO ? 'veh_8' : 'veh_7'));
      const result = await service.sync('drv_1', { changes: [change({ driverId: CO })] }, actor, NOW);
      expect(result.rejected[0]).toMatchObject({ clientId: 'client-1', code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });
      expect(logs.createLogEntry).not.toHaveBeenCalled();
    });

    it('B-118 — occurredAt inside an ENDED pairing does not authorise a record whose startAt lies outside it', async () => {
      const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
      const pairing = { id: 'pair_old', vehicleId: 'veh_1', startedAt: hours(-10), endedAt: hours(-5) };
      fullRepo.findPairingCovering.mockImplementation(async (_a: string, _b: string, at: Date) =>
        at >= pairing.startedAt && at <= pairing.endedAt ? pairing : null,
      );
      const result = await service.sync(
        'drv_1',
        { changes: [change({ driverId: CO, occurredAt: hours(-6), payload: { status: 'ON', startAt: hours(-1), annotation: 'Fuel stop' } } as never)] },
        actor,
        NOW,
      );
      expect(fullRepo.findPairingCovering).toHaveBeenCalledWith('drv_1', CO, hours(-1));
      expect(result.rejected[0]).toMatchObject({ clientId: 'client-1', code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });
      expect(logs.createLogEntry).not.toHaveBeenCalled();
      expect(audit.insert).not.toHaveBeenCalled();
    });

    it('B-118 — the pairing must cover endAt too, not just startAt', async () => {
      const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
      fullRepo.findPairingCovering.mockResolvedValue({ id: 'pair_1', vehicleId: 'veh_1', startedAt: hours(-10), endedAt: hours(-5) });
      const result = await service.sync(
        'drv_1',
        { changes: [change({ driverId: CO, occurredAt: hours(-6), payload: { status: 'SB', startAt: hours(-6), endAt: hours(-2), annotation: 'Sleeper' } } as never)] },
        actor,
        NOW,
      );
      expect(result.rejected[0]).toMatchObject({ code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });
      expect(logs.createLogEntry).not.toHaveBeenCalled();
    });

    it("B-118 — never corrects another driver's existing record (originalEventId) and bounds the timestamps", async () => {
      const corrected = await service.sync(
        'drv_1',
        { changes: [change({ driverId: CO, payload: { status: 'OFF', startAt: NOW, annotation: 'Correction', originalEventId: '42' } } as never)] },
        actor,
        NOW,
      );
      expect(corrected.rejected[0]).toMatchObject({ code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });

      const future = new Date(NOW.getTime() + 10 * 60_000);
      const tooNew = await service.sync('drv_1', { changes: [change({ clientId: 'c-f', driverId: CO, occurredAt: future })] }, actor, NOW);
      expect(tooNew.rejected[0]).toMatchObject({ clientId: 'c-f', code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });

      const old = new Date(NOW.getTime() - 31 * 86_400_000);
      const tooOld = await service.sync(
        'drv_1',
        { changes: [change({ clientId: 'c-o', driverId: CO, occurredAt: NOW, payload: { status: 'OFF', startAt: old, annotation: 'Old entry' } } as never)] },
        actor,
        NOW,
      );
      expect(tooOld.rejected[0]).toMatchObject({ clientId: 'c-o', code: ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED });
      expect(logs.createLogEntry).not.toHaveBeenCalled();
      expect(fullRepo.findPairingCovering).not.toHaveBeenCalled();
    });

    it('writes the delegation AuditLog only after the change was applied', async () => {
      (logs.createLogEntry as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      const result = await service.sync('drv_1', { changes: [change({ driverId: CO })] }, actor, NOW);
      expect(result.rejected[0]).toMatchObject({ clientId: 'client-1' });
      expect(audit.insert).not.toHaveBeenCalled();
    });

    it('driverId equal to the caller is the ordinary path (no pairing lookup)', async () => {
      await service.sync('drv_1', { changes: [change({ driverId: 'drv_1' })] }, actor, NOW);
      expect(fullRepo.findPairingCovering).not.toHaveBeenCalled();
      expect(logs.createLogEntry).toHaveBeenCalledWith('drv_1', expect.anything(), actor);
    });
  });
});
