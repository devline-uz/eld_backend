import { Injectable } from '@nestjs/common';
import type { Prisma, VehicleGroup } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export type VehicleGroupWithCount = VehicleGroup & { _count: { vehicles: number } };

@Injectable()
export class VehicleGroupsRepository extends BaseRepository<
  VehicleGroup,
  Prisma.VehicleGroupWhereInput,
  Prisma.VehicleGroupWhereUniqueInput,
  Prisma.VehicleGroupCreateInput,
  Prisma.VehicleGroupUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    VehicleGroup,
    Prisma.VehicleGroupWhereInput,
    Prisma.VehicleGroupWhereUniqueInput,
    Prisma.VehicleGroupCreateInput,
    Prisma.VehicleGroupUpdateInput
  > {
    return this.prisma.vehicleGroup;
  }

  listWithCounts(): Promise<VehicleGroupWithCount[]> {
    return this.prisma.vehicleGroup.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { vehicles: true } } },
    });
  }

  findWithCount(id: string): Promise<VehicleGroupWithCount | null> {
    return this.prisma.vehicleGroup.findUnique({
      where: { id },
      include: { _count: { select: { vehicles: true } } },
    });
  }

  findByName(name: string): Promise<VehicleGroup | null> {
    return this.prisma.vehicleGroup.findUnique({ where: { name } });
  }

  vehiclesOf(groupId: string) {
    return this.prisma.vehicle.findMany({
      where: { groupId },
      orderBy: { unitNumber: 'asc' },
      select: { id: true, unitNumber: true, vin: true, make: true, model: true, status: true },
    });
  }

  async existingVehicleIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Replaces the group's membership in one transaction: units not listed leave the group,
   * listed units join it (moving out of whatever group they were in before). */
  async setMembers(groupId: string, vehicleIds: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.vehicle.updateMany({
        where: { groupId, id: { notIn: vehicleIds } },
        data: { groupId: null },
      }),
      this.prisma.vehicle.updateMany({ where: { id: { in: vehicleIds } }, data: { groupId } }),
    ]);
  }
}
