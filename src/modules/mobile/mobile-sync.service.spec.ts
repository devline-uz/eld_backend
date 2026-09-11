/** TZ §13.4/13.6 — `POST /mobile/sync`: idempotent replay, rejection persistence, batch limits. */
import type { SyncedChange } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import type { LogsService } from '../logs/logs.service';
import type { SyncChangeDto, SyncRequestDto } from './dto/mobile.dto';
import type { MobileDvirService } from './mobile-dvir.service';
import { MobileSyncService } from './mobile-sync.service';
import type { MobileRepository } from './mobile.repository';

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
    service = new MobileSyncService(repo as unknown as MobileRepository, logs as unknown as LogsService, dvir as unknown as MobileDvirService);
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
    dvir.submit.mockResolvedValue({ id: 'dvir_1' });
    const dto: SyncRequestDto = {
      changes: [
        change({ type: 'certify', clientId: 'c-certify', payload: { dates: ['2026-09-10'] } }),
        change({ type: 'dvir', clientId: 'c-dvir', payload: { vehicleId: 'veh_1' } as never }),
      ],
    };
    const result = await service.sync('drv_1', dto, actor, NOW);
    expect(result.accepted.sort()).toEqual(['c-certify', 'c-dvir']);
    expect(logs.certify).toHaveBeenCalledWith({ dates: ['2026-09-10'], signatureImageId: undefined, driverId: undefined }, actor);
    expect(dvir.submit).toHaveBeenCalledWith('drv_1', { vehicleId: 'veh_1' }, actor);
  });

  it('processes changes in occurredAt order, not submission order', async () => {
    const order: string[] = [];
    logs.createLogEntry.mockImplementation((_driverId, payload) => {
      order.push(payload.annotation);
      return Promise.resolve({ id: 'evt' });
    });
    const later = change({ clientId: 'later', occurredAt: new Date(NOW.getTime() + 60_000), payload: { status: 'OFF', startAt: NOW, annotation: 'later' } });
    const earlier = change({ clientId: 'earlier', occurredAt: new Date(NOW.getTime() - 60_000), payload: { status: 'OFF', startAt: NOW, annotation: 'earlier' } });
    await service.sync('drv_1', { changes: [later, earlier] }, actor, NOW);
    expect(order).toEqual(['earlier', 'later']);
  });
});
