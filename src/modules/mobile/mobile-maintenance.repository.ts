import { Injectable } from '@nestjs/common';
import type { Attachment, MaintenanceSchedule, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export type MaintenanceWithInvoice = MaintenanceSchedule & {
  invoiceAttachment: Pick<Attachment, 'id' | 'key' | 'mimeType'> | null;
};

export interface DriverUnit {
  vehicleId: string;
  odometerMi: number;
}

/**
 * M-38..M-42 DB access for the driver maintenance API. Own repository (the back-office
 * `MaintenanceSchedulesRepository` lives in `ServiceModule`); everything is scoped by the unit the
 * driver currently has selected (`Driver.assignedVehicleId`).
 */
@Injectable()
export class MobileMaintenanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The driver's selected unit + its odometer in one query, or null when none is selected. */
  async findDriverUnit(driverId: string): Promise<DriverUnit | null> {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { assignedVehicle: { select: { id: true, odometerMi: true, deletedAt: true } } },
    });
    const vehicle = driver?.assignedVehicle;
    return vehicle && !vehicle.deletedAt ? { vehicleId: vehicle.id, odometerMi: vehicle.odometerMi } : null;
  }

  /** Enabled schedules of one unit — one query, no per-row lookups. */
  listForVehicle(vehicleId: string, take = 200): Promise<MaintenanceSchedule[]> {
    return this.prisma.maintenanceSchedule.findMany({ where: { vehicleId, enabled: true }, orderBy: { name: 'asc' }, take });
  }

  findOneForVehicle(id: string, vehicleId: string): Promise<MaintenanceWithInvoice | null> {
    return this.prisma.maintenanceSchedule.findFirst({
      where: { id, vehicleId, enabled: true },
      include: { invoiceAttachment: { select: { id: true, key: true, mimeType: true } } },
    });
  }

  /** An INVOICE upload of this driver — and not already the invoice of a DIFFERENT schedule. */
  findOwnInvoiceAttachment(id: string, driverId: string, scheduleId: string): Promise<{ id: string } | null> {
    return this.prisma.attachment.findFirst({
      where: {
        id,
        kind: 'INVOICE',
        uploadedById: driverId,
        uploadedByType: 'DRIVER',
        maintenanceInvoiceFor: { none: { id: { not: scheduleId } } },
      },
      select: { id: true },
    });
  }

  saveSubmission(id: string, data: Prisma.MaintenanceScheduleUncheckedUpdateInput): Promise<MaintenanceWithInvoice> {
    return this.prisma.maintenanceSchedule.update({
      where: { id },
      data,
      include: { invoiceAttachment: { select: { id: true, key: true, mimeType: true } } },
    });
  }
}
