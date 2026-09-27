import { Injectable } from '@nestjs/common';
import type { VehicleGroup } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { CreateVehicleGroupDto, SetVehicleGroupMembersDto, UpdateVehicleGroupDto } from './dto/vehicles.dto';
import { VehicleGroupsRepository, VehicleGroupWithCount } from './vehicle-groups.repository';

export interface VehicleGroupView {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  vehicleCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function toView(group: VehicleGroupWithCount): VehicleGroupView {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    color: group.color,
    vehicleCount: group._count.vehicles,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

/**
 * Vehicle groups — the web's W-12 IFTA `Vehicle group` filter and W-13 Activity `Group by`
 * menu. A unit belongs to at most one group (`Vehicle.groupId`); deleting a group leaves its
 * units ungrouped (FK `ON DELETE SET NULL`). Gated by `vehicles`, same as units and trailers.
 */
@Injectable()
export class VehicleGroupsService {
  constructor(private readonly groups: VehicleGroupsRepository) {}

  async list(): Promise<VehicleGroupView[]> {
    return (await this.groups.listWithCounts()).map(toView);
  }

  async get(id: string) {
    const group = await this.findOrThrow(id);
    return { ...toView(group), vehicles: await this.groups.vehiclesOf(id) };
  }

  async create(dto: CreateVehicleGroupDto): Promise<VehicleGroupView> {
    await this.assertNameFree(dto.name);
    const vehicleIds = dto.vehicleIds ? await this.assertVehiclesExist(dto.vehicleIds) : [];
    const group = await this.groups.create({ name: dto.name, description: dto.description, color: dto.color });
    if (vehicleIds.length > 0) await this.groups.setMembers(group.id, vehicleIds);
    return toView((await this.groups.findWithCount(group.id))!);
  }

  async update(id: string, dto: UpdateVehicleGroupDto): Promise<VehicleGroupView> {
    const current = await this.findOrThrow(id);
    if (dto.name !== undefined && dto.name !== current.name) await this.assertNameFree(dto.name);
    await this.groups.update(
      { id },
      {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.color !== undefined && { color: dto.color }),
      },
    );
    return toView((await this.groups.findWithCount(id))!);
  }

  async setMembers(id: string, dto: SetVehicleGroupMembersDto): Promise<VehicleGroupView> {
    await this.findOrThrow(id);
    await this.groups.setMembers(id, await this.assertVehiclesExist(dto.vehicleIds));
    return toView((await this.groups.findWithCount(id))!);
  }

  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    await this.groups.delete({ id });
  }

  private async findOrThrow(id: string): Promise<VehicleGroupWithCount> {
    const group = await this.groups.findWithCount(id);
    if (!group) throw new AppException(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.', 404);
    return group;
  }

  private async assertNameFree(name: string): Promise<void> {
    const existing: VehicleGroup | null = await this.groups.findByName(name);
    if (existing) throw AppException.conflict(`Vehicle group "${name}" already exists.`);
  }

  /** Every id must name a real unit — an unknown id is a 404, never silently dropped. */
  private async assertVehiclesExist(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const found = new Set(await this.groups.existingVehicleIds(unique));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, `Vehicle not found: ${missing.join(', ')}.`, 404);
    }
    return unique;
  }
}
