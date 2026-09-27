import { Injectable } from '@nestjs/common';
import type { Device, DriverHosSnapshot, EldEvent, UnidentifiedSegment } from '@prisma/client';
import { EVENT_TYPE } from '../ingest/event-codes';
import { PrismaService } from '../../core/prisma/prisma.service';

const UNIDENTIFIED_WINDOW_DAYS = 8;

/**
 * TZ §7.7 / §7.8 / §5.9 / §8.6 point 5 — MB-7 `GET /mobile/device-health` read model. Its own
 * repository (not folded into `MobileRepository`) per Phase 6b's "prefer your own new files"
 * rule; every query here is read-only.
 */
@Injectable()
export class DeviceHealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findDeviceByVehicle(vehicleId: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { vehicleId } });
  }

  /** §7.7/§7.8 — every eventType 7 (malfunction/diagnostic) record on this device, newest last,
   *  so the caller can fold logged (1/3) vs cleared (2/4) per code into "still active". */
  findMalfunctionEvents(deviceId: string): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { deviceId, eventType: EVENT_TYPE.MALFUNCTION_DIAGNOSTIC, recordStatus: 1 },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  /**
   * §5.9 / §20 B-83 — unassigned pool segments on this vehicle, PLUS any segment (on any
   * vehicle) a carrier put into PENDING_CONFIRMATION addressed to this driver — both are
   * "was this you?" prompts the driver-app must surface, within the last 8 days.
   */
  findPendingUnidentifiedSegments(vehicleId: string | null, driverId: string, since: Date): Promise<UnidentifiedSegment[]> {
    const or: Array<Record<string, unknown>> = [{ status: 'PENDING_CONFIRMATION', assignedDriverId: driverId }];
    if (vehicleId) or.push({ vehicleId, status: 'PENDING' });
    return this.prisma.unidentifiedSegment.findMany({
      where: { startAt: { gte: since }, OR: or },
      orderBy: { startAt: 'desc' },
      take: 200,
    });
  }

  findHosSnapshot(driverId: string): Promise<DriverHosSnapshot | null> {
    return this.prisma.driverHosSnapshot.findUnique({ where: { driverId } });
  }

  static get unidentifiedWindowDays(): number {
    return UNIDENTIFIED_WINDOW_DAYS;
  }
}
