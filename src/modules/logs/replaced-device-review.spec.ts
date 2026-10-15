/** D-163 — offline records from a replaced device: window, inert status, row planning, session lookup. */
import {
  planReplacedDeviceRows,
  ReplacedDeviceReviewService,
  reviewedRecordStatus,
  reviewFor,
  type DeviceReviewContext,
} from './replaced-device-review';
import type { PrismaService } from '../../core/prisma/prisma.service';
import { LogsRepository } from './logs.repository';

const at = (iso: string) => new Date(iso);
const context: DeviceReviewContext = {
  deviceId: 'dev-A',
  loginAt: at('2026-10-15T18:00:00Z'),
  replaced: [
    { revokedAt: at('2026-10-15T08:00:00Z'), deviceLabel: 'Pixel 6' },
    { revokedAt: at('2026-10-15T12:00:00Z'), deviceLabel: 'Pixel 7' },
  ],
};
const REVIEW = { reviewReason: 'REPLACED_DEVICE' as const, reviewDeviceLabel: 'Pixel 7' };

describe('reviewFor — the replaced-device window [revokedAt, re-login)', () => {
  it('flags a record at or after the takeover and before the re-login, with the newest window label', () => {
    expect(reviewFor(context, at('2026-10-15T12:00:00Z'))).toEqual({ reviewReason: 'REPLACED_DEVICE', reviewDeviceLabel: 'Pixel 7' });
    expect(reviewFor(context, at('2026-10-15T09:00:00Z'))).toEqual({ reviewReason: 'REPLACED_DEVICE', reviewDeviceLabel: 'Pixel 6' });
  });

  it('B-179 — an old window ends at the re-login that followed it, not at the current login', () => {
    // A replaced 08:00, driver back on A 09:00 (until), A replaced again 12:00, back on A 18:00.
    const bounded: DeviceReviewContext = {
      ...context,
      replaced: [
        { revokedAt: at('2026-10-15T08:00:00Z'), deviceLabel: 'Pixel 6', until: at('2026-10-15T09:00:00Z') },
        { revokedAt: at('2026-10-15T12:00:00Z'), deviceLabel: 'Pixel 7', until: at('2026-10-15T18:00:00Z') },
      ],
    };
    expect(reviewFor(bounded, at('2026-10-15T08:30:00Z'))).toEqual({ reviewReason: 'REPLACED_DEVICE', reviewDeviceLabel: 'Pixel 6' });
    // Made on A between its re-login (09:00) and the next takeover (12:00) — legitimate, not flagged.
    expect(reviewFor(bounded, at('2026-10-15T09:00:00Z'))).toBeNull();
    expect(reviewFor(bounded, at('2026-10-15T11:59:59Z'))).toBeNull();
    expect(reviewFor(bounded, at('2026-10-15T13:00:00Z'))).toEqual({ reviewReason: 'REPLACED_DEVICE', reviewDeviceLabel: 'Pixel 7' });
  });

  it('does not flag a record before any takeover, at/after the re-login, or without a context', () => {
    expect(reviewFor(context, at('2026-10-15T07:59:59Z'))).toBeNull();
    expect(reviewFor(context, at('2026-10-15T18:00:00Z'))).toBeNull();
    expect(reviewFor(context, at('2026-10-15T19:00:00Z'))).toBeNull();
    expect(reviewFor(null, at('2026-10-15T12:30:00Z'))).toBeNull();
  });
});

describe('reviewedRecordStatus — what the flag does to the stored record', () => {
  it('never alters ELD-automatic records (PT30 driving and the status that ends it)', () => {
    expect(reviewedRecordStatus({ eventType: 1, eventCode: 3, recordOrigin: 1, recordStatus: 1 }, REVIEW)).toBe(1);
    expect(reviewedRecordStatus({ eventType: 1, eventCode: 4, recordOrigin: 1, recordStatus: 1 }, REVIEW)).toBe(1);
  });

  it('stores driver-entered duty and PC/YM records inert (3), driver-origin D included', () => {
    expect(reviewedRecordStatus({ eventType: 1, eventCode: 1, recordOrigin: 2, recordStatus: 1 }, REVIEW)).toBe(3);
    expect(reviewedRecordStatus({ eventType: 1, eventCode: 3, recordOrigin: 2, recordStatus: 1 }, REVIEW)).toBe(3);
    expect(reviewedRecordStatus({ eventType: 3, eventCode: 1, recordOrigin: 2, recordStatus: 1 }, REVIEW)).toBe(3);
  });

  it('labels other record types only and passes through non-active statuses and unflagged records', () => {
    expect(reviewedRecordStatus({ eventType: 5, eventCode: 1, recordOrigin: 2, recordStatus: 1 }, REVIEW)).toBe(1);
    expect(reviewedRecordStatus({ eventType: 1, eventCode: 1, recordOrigin: 2, recordStatus: 2 }, REVIEW)).toBe(2);
    expect(reviewedRecordStatus({ eventType: 1, eventCode: 1, recordOrigin: 2, recordStatus: 1 }, null)).toBe(1);
  });
});

describe('planReplacedDeviceRows — a late self-edit retires nothing', () => {
  it('drops the Inactive-Changed marker and the neutralizer, keeps the rest inert with supersedesId', () => {
    const rows = [
      { kind: 'INACTIVE_MARKER', eventType: 1, eventCode: 4, recordOrigin: 2, recordStatus: 2, supersedesId: 9n },
      { kind: 'NEUTRALIZE', eventType: 1, eventCode: 1, recordOrigin: 2, recordStatus: 1, supersedesId: 9n },
      { kind: 'NEW_ACTIVE', eventType: 1, eventCode: 2, recordOrigin: 2, recordStatus: 1, supersedesId: 9n },
      { kind: 'RESTORE', eventType: 1, eventCode: 3, recordOrigin: 2, recordStatus: 1, supersedesId: null },
    ];
    expect(planReplacedDeviceRows(rows, REVIEW)).toEqual([
      { kind: 'NEW_ACTIVE', eventType: 1, eventCode: 2, recordOrigin: 2, recordStatus: 3, supersedesId: 9n },
      { kind: 'RESTORE', eventType: 1, eventCode: 3, recordOrigin: 2, recordStatus: 3, supersedesId: null },
    ]);
  });
});

describe('ReplacedDeviceReviewService.contextFor', () => {
  function service(current: unknown, replaced: unknown[], first: unknown = null) {
    const prisma = {
      driverSession: {
        findUnique: jest.fn(async () => current),
        findMany: jest.fn(async () => replaced),
        findFirst: jest.fn(async () => first),
      },
    };
    return { svc: new ReplacedDeviceReviewService(prisma as unknown as PrismaService), prisma };
  }

  it('uses the first createdAt of the rotation family as the login and only other-device takeovers', async () => {
    const { svc, prisma } = service(
      { driverId: 'd1', deviceId: 'dev-A', familyId: 'fam-1', createdAt: at('2026-10-15T19:00:00Z') },
      [{ revokedAt: at('2026-10-15T12:00:00Z'), deviceLabel: 'Pixel 7' }],
      { createdAt: at('2026-10-15T18:00:00Z') },
    );
    const ctx = await svc.contextFor('d1', 'sess-2');
    expect(ctx).toEqual({
      deviceId: 'dev-A',
      loginAt: at('2026-10-15T18:00:00Z'),
      replaced: [{ revokedAt: at('2026-10-15T12:00:00Z'), deviceLabel: 'Pixel 7', until: at('2026-10-15T18:00:00Z') }],
    });
    expect(prisma.driverSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          driverId: 'd1',
          deviceId: 'dev-A',
          revokedReason: 'REPLACED',
          OR: [{ replacedByDeviceId: null }, { replacedByDeviceId: { not: 'dev-A' } }],
        }) as unknown,
      }),
    );
  });

  it('B-179 — bounds every window by the first session row created on the device after the takeover', async () => {
    const prisma = {
      driverSession: {
        findUnique: jest.fn(async () => ({ driverId: 'd1', deviceId: 'dev-A', familyId: null, createdAt: at('2026-10-15T18:00:00Z') })),
        findMany: jest.fn(async () => [
          { revokedAt: at('2026-10-15T12:00:00Z'), deviceLabel: 'Pixel 7' },
          { revokedAt: at('2026-10-15T08:00:00Z'), deviceLabel: 'Pixel 6' },
        ]),
        findFirst: jest.fn(async (args: { where: { createdAt: { gt: Date } } }) =>
          args.where.createdAt.gt.getTime() === at('2026-10-15T08:00:00Z').getTime()
            ? { createdAt: at('2026-10-15T09:00:00Z') }
            : { createdAt: at('2026-10-15T18:00:00Z') },
        ),
      },
    };
    const ctx = await new ReplacedDeviceReviewService(prisma as unknown as PrismaService).contextFor('d1', 's');
    expect(ctx?.replaced.map((w) => w.until)).toEqual([at('2026-10-15T18:00:00Z'), at('2026-10-15T09:00:00Z')]);
    expect(prisma.driverSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { driverId: 'd1', deviceId: 'dev-A', createdAt: { gt: at('2026-10-15T08:00:00Z') } } }),
    );
    expect(reviewFor(ctx, at('2026-10-15T10:00:00Z'))).toBeNull();
  });

  it('returns null without a session, for another driver, a legacy session, or a never-replaced device', async () => {
    expect(await service(null, []).svc.contextFor('d1', undefined)).toBeNull();
    expect(await service({ driverId: 'd2', deviceId: 'dev-A', familyId: null, createdAt: new Date() }, []).svc.contextFor('d1', 's')).toBeNull();
    expect(await service({ driverId: 'd1', deviceId: null, familyId: null, createdAt: new Date() }, []).svc.contextFor('d1', 's')).toBeNull();
    expect(await service({ driverId: 'd1', deviceId: 'dev-A', familyId: null, createdAt: new Date() }, []).svc.contextFor('d1', 's')).toBeNull();
  });
});

describe('B-180 — LogsRepository.findReviewEvents keeps the newest flagged records under the cap', () => {
  it('queries newest first with the cap and returns them oldest first', async () => {
    const findMany = jest.fn(async () => [{ id: 3n }, { id: 2n }]);
    const repo = new LogsRepository({ eldEvent: { findMany } } as unknown as PrismaService);
    const rows = await repo.findReviewEvents('d1', 'REPLACED_DEVICE', 2);
    expect(findMany).toHaveBeenCalledWith({
      where: { driverId: 'd1', reviewReason: 'REPLACED_DEVICE' },
      orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
      take: 2,
    });
    expect(rows.map((row) => row.id)).toEqual([2n, 3n]);
  });
});
