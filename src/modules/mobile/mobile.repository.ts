import { Injectable } from '@nestjs/common';
import type {
  Carrier,
  CoDriverPairing,
  Device,
  Driver,
  Dvir,
  EldEvent,
  Prisma,
  PushToken,
  SyncedChange,
  Vehicle,
} from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface DvirCreateInput {
  driverId: string;
  vehicleId: string;
  trailerId?: string | null;
  type: 'PRE_TRIP' | 'POST_TRIP' | 'INTERMEDIATE';
  submittedAt: Date;
  odometerMi: number;
  latitude?: number | null;
  longitude?: number | null;
  locationName?: string | null;
  vehicleCondition: 'SATISFACTORY' | 'DEFECTS_FOUND';
  notes?: string | null;
  driverSignatureUrl: string;
  driverSignatureHash: string;
  defects: Array<{
    vehicleId: string;
    part: 'TRUCK' | 'TRAILER';
    category: string;
    severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
    description: string;
    outOfService: boolean;
    /** MB-6 — `Attachment.id`s already validated as the driver's own, unlinked DVIR photos. */
    photoAttachmentIds?: string[];
  }>;
}

/**
 * TZ §3.5 — every DB call for Phase 6 (Mobile API) lives here. `SyncedChange` is the primary
 * model (the sync idempotency ledger, §13.4/13.6); the ad hoc methods below reach into every
 * other table the bootstrap/DVIR/duty-status endpoints need, exactly like
 * `HosRecalcRepository` does for the HOS engine.
 */
@Injectable()
export class MobileRepository extends BaseRepository<
  SyncedChange,
  Prisma.SyncedChangeWhereInput,
  Prisma.SyncedChangeWhereUniqueInput,
  Prisma.SyncedChangeCreateInput,
  Prisma.SyncedChangeUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    SyncedChange,
    Prisma.SyncedChangeWhereInput,
    Prisma.SyncedChangeWhereUniqueInput,
    Prisma.SyncedChangeCreateInput,
    Prisma.SyncedChangeUpdateInput
  > {
    return this.prisma.syncedChange;
  }

  // ---------------------------------------------------------------------
  // §13.4/13.6 — the sync idempotency ledger
  // ---------------------------------------------------------------------

  /**
   * §13.6 — the idempotency ledger is looked up PER DRIVER. `SyncedChange.clientId` is unique
   * across the whole table, and the value is chosen by the mobile client, so an unscoped
   * lookup let driver A burn an arbitrary `clientId` and have driver B's genuine queued
   * change silently skipped (and A read B's outcome). The stored key is therefore namespaced
   * with the driver id; the bare form is still accepted on read so rows written before this
   * change stay idempotent for their own driver.
   */
  findSyncedByClientId(driverId: string, clientId: string): Promise<SyncedChange | null> {
    return this.prisma.syncedChange.findFirst({
      where: {
        OR: [
          { clientId: syncLedgerKey(driverId, clientId) },
          { clientId, driverId },
        ],
      },
    });
  }

  /**
   * Records the OUTCOME of a processed change (§13.4/13.6). Written once, after the underlying
   * mutation has already succeeded or failed, so a crash mid-request never leaves a phantom
   * "accepted" ledger row for work that was never actually applied. The `clientId` unique
   * constraint is the defensive backstop for the rare case of two truly concurrent replays of
   * the same batch — the loser's insert fails with P2002 and is treated exactly like an
   * already-processed change (re-read and return the winner's outcome).
   */
  async recordSyncedResult(
    driverId: string,
    clientId: string,
    type: string,
    occurredAt: Date,
    status: 'ACCEPTED' | 'REJECTED',
    errorCode: string | null,
    result: Prisma.InputJsonValue | undefined,
  ): Promise<{ status: 'ACCEPTED' | 'REJECTED'; errorCode: string | null } | 'DUPLICATE'> {
    try {
      const row = await this.prisma.syncedChange.create({
        data: {
          driverId,
          clientId: syncLedgerKey(driverId, clientId),
          type,
          status,
          errorCode,
          occurredAt,
          result: result ?? undefined,
        },
      });
      return { status: row.status, errorCode: row.errorCode };
    } catch (err) {
      if (isUniqueViolation(err)) return 'DUPLICATE';
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Bootstrap composition (§11.8, §13.2)
  // ---------------------------------------------------------------------

  findDriver(driverId: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id: driverId } });
  }

  findCarrier(): Promise<Carrier | null> {
    return this.prisma.carrier.findUnique({ where: { id: 'carrier' } });
  }

  findVehicle(vehicleId: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
  }

  findDeviceByVehicle(vehicleId: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { vehicleId } });
  }

  findActivePairing(driverId: string): Promise<CoDriverPairing | null> {
    return this.prisma.coDriverPairing.findFirst({
      where: {
        OR: [{ primaryDriverId: driverId }, { coDriverId: driverId }],
        endedAt: null,
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  findPushTokens(driverId: string): Promise<PushToken[]> {
    return this.prisma.pushToken.findMany({ where: { driverId } });
  }

  touchLastSync(driverId: string, at: Date): Promise<Driver> {
    return this.prisma.driver.update({ where: { id: driverId }, data: { lastSyncAt: at } });
  }

  // ---------------------------------------------------------------------
  // §13.4 — `serverChanges`: RODS records the app does not have yet
  // ---------------------------------------------------------------------

  findEventsSince(driverId: string, since: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, createdAt: { gt: since } },
      orderBy: [{ createdAt: 'asc' }],
      take: 1000,
    });
  }

  // ---------------------------------------------------------------------
  // §5.10 / §6 — DVIR + signature (mobile submission)
  // ---------------------------------------------------------------------

  async createDvir(input: DvirCreateInput): Promise<Dvir> {
    const photoIds = input.defects.flatMap((defect) => defect.photoAttachmentIds ?? []);
    return this.prisma.dvir.create({
      data: {
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        trailerId: input.trailerId ?? null,
        type: input.type,
        submittedAt: input.submittedAt,
        odometerMi: input.odometerMi,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        locationName: input.locationName ?? null,
        vehicleCondition: input.vehicleCondition,
        notes: input.notes ?? null,
        driverSignatureUrl: input.driverSignatureUrl,
        driverSignatureHash: input.driverSignatureHash,
        // MB-6 — nested `create` (not `createMany`) so each defect can `connect` its photos;
        // the whole DVIR + defects + photo links land in ONE transaction.
        defects: input.defects.length
          ? {
              create: input.defects.map((defect) => ({
                vehicleId: defect.vehicleId,
                part: defect.part,
                category: defect.category,
                severity: defect.severity,
                description: defect.description,
                outOfService: defect.outOfService,
                ...(defect.photoAttachmentIds?.length
                  ? { photos: { connect: defect.photoAttachmentIds.map((id) => ({ id })) } }
                  : {}),
              })),
            }
          : undefined,
        ...(photoIds.length ? { photos: { connect: photoIds.map((id) => ({ id })) } } : {}),
      },
      include: { defects: true },
    });
  }

  markVehicleOutOfService(vehicleId: string): Promise<Vehicle> {
    return this.prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'OUT_OF_SERVICE' } });
  }

  attachPhotos(dvirId: string, defectIdByOrder: Map<number, string>, photosByOrder: Map<number, string[]>): Promise<unknown> {
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const [order, attachmentIds] of photosByOrder) {
      const defectId = defectIdByOrder.get(order);
      if (!defectId || !attachmentIds.length) continue;
      updates.push(
        this.prisma.attachment.updateMany({
          where: { id: { in: attachmentIds } },
          data: { dvirId, defectId },
        }),
      );
    }
    if (!updates.length) return Promise.resolve(undefined);
    return this.prisma.$transaction(updates);
  }

  findAttachments(ids: string[]): Promise<{ id: string; key: string; sha256: string | null }[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.attachment.findMany({
      where: { id: { in: ids } },
      select: { id: true, key: true, sha256: true },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/** Driver-scoped idempotency key for `SyncedChange.clientId` (never returned to a client —
 * the sync response echoes the raw `clientId` from the request). */
export function syncLedgerKey(driverId: string, clientId: string): string {
  return `${driverId}:${clientId}`;
}
