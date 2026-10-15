/**
 * Backend-tasks item 7 / decisions.md D-163 — offline records from a REPLACED device.
 *
 * Single-device rule (D-159…D-162): a login on device B ends device A's session as
 * `revokedReason = 'REPLACED'`. A keeps its offline queue on disk and delivers it only after the
 * driver logs in on A again (new session, same `deviceId`). Records never migrate between
 * devices, so the CALLER's current session `deviceId` is the device the record came from.
 *
 * A record is flagged `reviewReason = 'REPLACED_DEVICE'` when the driver has a session with the
 * caller's `deviceId` that was REPLACED (by another device) at `revokedAt <= occurredAt`, and
 * `occurredAt` is before the caller's current LOGIN (the first `createdAt` of its rotation
 * family — a refresh rotation is not a re-login). Records after the re-login are normal.
 *
 * Flagged records are NEVER rejected. What a flag does to the record (`reviewedRecordStatus`):
 *   - ELD-automatic records (`recordOrigin = 1`: PT30 Driving and the automatic status that ends
 *     it, intermediate logs, power/login records…) keep their status — device truth is never
 *     altered, only labelled;
 *   - driver-entered duty-status (eventType 1) and PC/YM (eventType 3) records are stored INERT,
 *     `recordStatus = 3` ("Inactive – Change Requested", Appendix A 7.23): every RODS-graph, HOS,
 *     violation and eRODS-active reader filters `recordStatus = 1`, so they change nothing until
 *     a fleet manager re-enters them through the normal §395.30 edit flow.
 */
import { Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

export const REVIEW_REASON_REPLACED_DEVICE = 'REPLACED_DEVICE' as const;
export const REVIEW_REASONS = [REVIEW_REASON_REPLACED_DEVICE] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** Appendix A 7.23 — "Inactive – Change Requested": stored, shown, never counted. */
export const REVIEW_INERT_RECORD_STATUS = 3;

export interface ReplacedSessionWindow {
  /** When device A's session was ended as REPLACED. */
  revokedAt: Date;
  /** A's own label at that time (the device the record came from). */
  deviceLabel: string | null;
  /**
   * B-179 — when the driver next logged in on this device after `revokedAt` (the window's end).
   * Records after it were made while the device legitimately held the session. Absent: open until
   * the caller's `loginAt`.
   */
  until?: Date | null;
}

/** The caller's device and the replacement history of that device for this driver. */
export interface DeviceReviewContext {
  deviceId: string;
  /** First `createdAt` of the caller's session family = when the driver logged in on this device. */
  loginAt: Date;
  /** Sessions of THIS device that another device replaced, newest first. */
  replaced: ReplacedSessionWindow[];
}

export interface RecordReview {
  reviewReason: ReviewReason;
  reviewDeviceLabel: string | null;
}

/** Pure — the flag for one record, or null when it is a normal record. */
export function reviewFor(context: DeviceReviewContext | null, occurredAt: Date): RecordReview | null {
  if (!context) return null;
  const at = occurredAt.getTime();
  if (at >= context.loginAt.getTime()) return null;
  const hit = context.replaced
    .filter((window) => window.revokedAt.getTime() <= at && (!window.until || at < window.until.getTime()))
    .sort((a, b) => b.revokedAt.getTime() - a.revokedAt.getTime())[0];
  if (!hit) return null;
  return { reviewReason: REVIEW_REASON_REPLACED_DEVICE, reviewDeviceLabel: hit.deviceLabel };
}

/**
 * Pure — the record status a flagged record is stored with. ELD-automatic records
 * (`recordOrigin = 1`, PT30 Driving included) keep their own status; a driver-entered duty or
 * PC/YM record that would be active is stored inert (3) — including a driver-origin D row (e.g.
 * the RESTORE row of a self-edit that ends inside driving), which must never become manual
 * driving time (§395.26(b)). Non-active statuses pass through untouched.
 */
export function reviewedRecordStatus(
  row: { eventType: number; eventCode: number; recordOrigin: number; recordStatus: number },
  review: RecordReview | null,
): number {
  if (!review || row.recordStatus !== 1) return row.recordStatus;
  if (row.recordOrigin === 1) return row.recordStatus;
  if (row.eventType === 1 || row.eventType === 3) return REVIEW_INERT_RECORD_STATUS;
  return row.recordStatus;
}

@Injectable()
export class ReplacedDeviceReviewService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's review context, or null when nothing can be flagged (no session id, legacy
   * session without `deviceId`, or this device was never replaced). One indexed lookup per call.
   */
  async contextFor(driverId: string, sessionId: string | undefined): Promise<DeviceReviewContext | null> {
    if (!sessionId) return null;
    const current = await this.prisma.driverSession.findUnique({
      where: { id: sessionId },
      select: { driverId: true, deviceId: true, familyId: true, createdAt: true },
    });
    if (!current || current.driverId !== driverId || !current.deviceId) return null;
    const deviceId = current.deviceId;
    const replaced = await this.prisma.driverSession.findMany({
      where: {
        driverId,
        deviceId,
        revokedReason: 'REPLACED',
        revokedAt: { not: null },
        // A same-device re-login also ends older same-device sessions as REPLACED; only a
        // takeover by ANOTHER device opens a review window.
        OR: [{ replacedByDeviceId: null }, { replacedByDeviceId: { not: deviceId } }],
      },
      select: { revokedAt: true, deviceLabel: true },
      orderBy: { revokedAt: 'desc' },
      take: 50,
    });
    if (!replaced.length) return null;
    let loginAt = current.createdAt;
    if (current.familyId) {
      const first = await this.prisma.driverSession.findFirst({
        where: { driverId, OR: [{ familyId: current.familyId }, { id: current.familyId }] },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      if (first && first.createdAt < loginAt) loginAt = first.createdAt;
    }
    // B-179 — each window ends at the next login on this device after the takeover (the first
    // session row created after `revokedAt`: single-device means no family of this device survives
    // the takeover, so that row starts a new family). Without this an old window stayed open up to
    // the CURRENT login and inerted records made while the device legitimately held the session.
    const windows = await Promise.all(
      replaced.map(async (row) => {
        const revokedAt = row.revokedAt as Date;
        const next = await this.prisma.driverSession.findFirst({
          where: { driverId, deviceId, createdAt: { gt: revokedAt } },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
        });
        return { revokedAt, deviceLabel: row.deviceLabel, until: next?.createdAt ?? null };
      }),
    );
    return { deviceId, loginAt, replaced: windows };
  }
}

/** Import-free module (PrismaService is global) so ingest and logs can both use it without a cycle. */
@Module({ providers: [ReplacedDeviceReviewService], exports: [ReplacedDeviceReviewService] })
export class ReplacedDeviceReviewModule {}

/**
 * Pure — a driver self-edit (`planDriverSelfEdit` rows) delivered late by a replaced device.
 * The rows that ACT on the active timeline (the "Inactive – Changed" marker retiring the original
 * and the NEUTRALIZE re-statement) are dropped: the original stays exactly as it is. Every other
 * row keeps its content (and `supersedesId`, so the reviewer sees which record the driver meant)
 * but is stored inert per `reviewedRecordStatus`.
 */
export function planReplacedDeviceRows<T extends { kind: string; eventType: number; eventCode: number; recordOrigin: number; recordStatus: number }>(
  rows: T[],
  review: RecordReview,
): T[] {
  return rows
    .filter((row) => row.kind !== 'INACTIVE_MARKER' && row.kind !== 'NEUTRALIZE')
    .map((row) => ({ ...row, recordStatus: reviewedRecordStatus(row, review) }));
}
